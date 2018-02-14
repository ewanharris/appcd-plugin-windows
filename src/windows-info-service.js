import DetectEngine from 'appcd-detect';
import fs from 'fs';
import gawk from 'gawk';
import path from 'path';
import * as windowslib from 'windowslib';
import * as registry from 'appcd-winreg';
import version from './version';

import { DataServiceDispatcher } from 'appcd-dispatcher';
import { expandPath } from 'appcd-path';
import { cache, debounce as debouncer, get, arrayify } from 'appcd-util';

let vswhere;

/**
 * Constants to identify the subscription id list.
 * @type {Number}
 */
const VISUAL_STUDIO_INSTALL_DIR = 1;
const VSWHERE_INSTALL_DIR = 2;

/**
 * The Windows info service.
 */
export default class WindowsInfoService extends DataServiceDispatcher {

	/**
	 * Initializes the timers for polling Windows information.
	 *
	 * @param {Config} cfg - An Appc Daemon config object.
	 * @returns {Promise}
	 * @access public
	 */
	async activate(cfg) {
		this.data = gawk({
			devices: [],
			sdk: [],
			visualstudio: {}
		});

		this.timers = {};

		/**
		 * A map of buckets to a list of active fs watch subscription ids.
		 * @type {Object}
		 */
		this.subscriptions = {};

		// // wire up Visual Studio detection first so that we can use its result to know if we should query the other thing
		// await this.wireupDetection('visualstudio', get(cfg, 'windows.visualstudio.pollInterval') || 60000 * 10, () => this.detectVisualStudios());
		//
		// await Promise.all([
		// 	this.wireupDetection('emulators',      get(cfg, 'windows.emulators.pollInterval')    || 60000 * 5,  () => this.detectEmulators()),
		// 	this.wireupDetection('windows',        get(cfg, 'windows.windowsSDK.pollInterval')   || 60000 / 2,  () => this.detectWindowsSDKs()),
		// 	this.wireupDetection('windowsphone',   get(cfg, 'windows.windowsPhone.pollInterval') || 60000 / 2,  () => this.detectWindowsPhone())
		// ]);
		//
		// // wire up devices after the rest to avoid DAEMON-173 where emulator and
		// // device detect functions attempt to build and write wptool at the same time
		// await this.wireupDetection('devices',      get(cfg, 'windows.device.pollInterval')       || 2500,       () => this.detectDevices());
		await Promise.all([
			this.initSDKAndDevices(),
			this.initVS()
		]);
	}

	async initSDKAndDevices() {

		this.sdkDetectEngine = new DetectEngine({
			checkDir(dir) {
				try {
					const sdk = new windowslib.SDK(dir);
					// Lets just ignore everything below 10
					if (version.gte(sdk.version, '10')) {
						return sdk;
					}
				} catch (e) {
					// Do nothing
					console.log(e);
				}
			},
			registryCallback: async () => {
				const results = {
					paths: []
				};
				const sdkInstalls = await registry.keys('HKLM', 'SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\Windows');
				for (const key of sdkInstalls) {
					try {
						const value = await registry.get('HKLM', key, 'InstallationFolder');
						results.paths.push(value);
					} catch (e) {
						// Do nothing
					}
				}
				return results;
			},
			processResults: async (results, engine) => {
				// loop over all of the new sdks and set default version
				if (results.length) {
					let foundDefault = false;
					for (const result of results) {
						if (!foundDefault && (!engine.defaultPath || result.path === engine.defaultPath)) {
							result.default = true;
							foundDefault = true;
						} else {
							result.default = false;
						}
					}

					if (!foundDefault) {
						// since sdks aren't in any particular order, the first one is a good one
						results[0].default = true;
					}
				}
			},
			redetect: true,
			watch: true,
			depth: 1,
			multiple: true
		});

		this.sdkDetectEngine.on('results', async results => {
			gawk.set(this.data.sdk, results);
		});

		return this.sdkDetectEngine.start()
			.then(async results => {
				if (results && results[0] && results[0].revisions) {
					const rev = results[0].revisions[0];
					gawk.set(this.data.devices, await windowslib.device.getDevices({ sdk: rev }));
					this.rescanDevices();
				}
			});
	}

	async initVS() {
		const defaultDir = expandPath(windowslib.visualstudio.defaultInstallDir);
		if (fs.existsSync(defaultDir)) {
			let dirs = fs.readdirSync(defaultDir).filter(dir => parseInt(dir, 10));
			const paths = [];
			for (const dir of dirs) {
				paths.push(path.join(defaultDir, dir.toString()));
			}
			// FIXME: Watching recursively seems to be watching way too many dirs when we install
			this.watch({
				type: VISUAL_STUDIO_INSTALL_DIR,
				paths,
				debounce: true,
				handler: async (msg) => {
					if ((msg.action === 'add' || msg.action === 'change') && !this.subscriptions.hasOwnProperty(msg.file)) {
						this.subscriptions[msg.file] = {};
						this.watch({
							type: msg.file,
							paths: [ msg.file ],
							debounce: true,
							handler: async () => {
								const visualStudios = await this.scanVisualStudio();
								gawk.set(this.data.visualstudio, visualStudios);
							}
						});
					}
				},
				depth: 1
			});
		} else {
			// Otherwise just watch it til it comes around
			this.watch({
				type: VISUAL_STUDIO_INSTALL_DIR,
				paths: [ windowslib.visualstudio.defaultInstallDir ],
				debounce: true,
				handler: () => {
					this.scanVisualStudio();
				}
			});
		}

		this.watch({
			type: VSWHERE_INSTALL_DIR,
			paths: [ windowslib.vswhere.defaultPath ],
			debounce: true,
			handler: () => {
				this.scanVisualStudio();
			}
		});
		await this.scanVisualStudio();
	}

	async scanVisualStudio() {
		vswhere = await windowslib.vswhere.getVSWhere();
		if (vswhere) {
			const { code, stdout, stderr } = await vswhere.detect();
			const vsIds = new Set(Object.keys(this.data.visualstudio));
			if (!code) {
				const visualStudios = {};
				const visualStudioData = JSON.parse(stdout);
				for (const vs of visualStudioData) {
					try {
						const visualStudio = new windowslib.VisualStudio(vs);
						visualStudios[vs.instanceId] = visualStudio;
						vsIds.delete(vs.instanceId);
						if (!this.subscriptions.hasOwnProperty(vs.instanceId)) {
							this.subscriptions[vs.instanceId] = {};
							// Set up watchers for each VS install so we can rescan
							if (this.subscriptions.hasOwnProperty(vs.installationPath)) {
								this.unwatch(vs.installationPath);
							}
							this.watch({
								type: vs.instanceId,
								paths: [ vs.installationPath ],
								debounce: true,
								handler: () => {
									this.scanVisualStudio();
								}
							});
						}
					} catch (e) {
						console.log(e);
					}
				}

				for (const id of vsIds) {
					this.unwatch(id);
				}
				gawk.set(this.data.visualstudio, visualStudios);
			}
		}
	}

	async rescanDevices() {
		// TODO: Move to a constant with overridable config values
		const interval = 2500;
		if (this.data.sdk && this.data.sdk[0] && this.data.sdk[0].revisions) {
			const rev = this.data.sdk[0].revisions[0];
			const devices = await windowslib.device.getDevices({ sdk: rev });
			console.log(devices);
			if (devices) {
				console.log('Updating data for devices');
				gawk.set(this.data.devices, devices);
			}
			this.timers.device = setTimeout(() => {
				this.rescanDevices();
			}, interval);
		}
	}

	/**
	 * Stops all active timers.
	 *
	 * @access public
	 */
	deactivate() {
		for (const timer of Object.values(this.timers)) {
			clearTimeout(timer);
		}
		this.timers = {};
	}

	/**
	 * Subscribes to filesystem events for the specified paths.
	 *
	 * @param {Object} params - Various parameters.
	 * @param {Boolean} [params.debounce=false] - When `true`, wraps the `handler` with a debouncer.
	 * @param {Number} [params.depth] - The max depth to recursively watch.
	 * @param {Function} params.handler - A callback function to fire when a fs event occurs.
	 * @param {Array.<String>} params.paths - One or more paths to watch.
	 * @param {String} params.type - The type of subscription.
	 * @access private
	 */
	watch({ debounce, depth, handler, paths, type }) {
		const callback = debounce ? debouncer(handler) : handler;

		for (const path of paths) {
			const data = { path };
			if (depth) {
				data.recursive = true;
				data.depth = depth;
			}

			appcd
				.call('/appcd/fswatch', {
					data,
					type: 'subscribe'
				})
				.then(ctx => {
					let sid;
					ctx.response
						.on('data', async (data) => {
							if (data.type === 'subscribe') {
								sid = data.sid;
								if (!this.subscriptions[type]) {
									this.subscriptions[type] = {};
								}
								this.subscriptions[type][data.sid] = 1;
							} else if (data.type === 'event') {
								callback(data.message);
							}
						})
						.on('end', () => {
							if (sid && this.subscriptions[type]) {
								delete this.subscriptions[type][sid];
							}
						});
				});
		}
	}

	/**
	 * Unsubscribes a list of filesystem watcher subscription ids.
	 *
	 * @param {Number} type - The type of subscription.
	 * @param {Array.<String>} [sids] - An array of subscription ids to unsubscribe. If not
	 * specified, defaults to all sids for the specified types.
	 * @returns {Promise}
	 * @access private
	 */
	async unwatch(type, sids) {
		if (!this.subscriptions[type]) {
			return;
		}

		if (!sids) {
			sids = Object.keys(this.subscriptions[type]);
		}

		for (const sid of sids) {
			await appcd.call('/appcd/fswatch', {
				sid,
				type: 'unsubscribe'
			});

			delete this.subscriptions[type][sid];
		}

		if (!Object.keys(this.subscriptions[type]).length) {
			delete this.subscriptions[type];
		}
	}
}
