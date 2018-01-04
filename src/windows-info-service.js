import DetectEngine from 'appcd-detect';
import gawk from 'gawk';
import * as windowslib from 'windowslib';
import * as registry from 'appcd-winreg';

import { DataServiceDispatcher } from 'appcd-dispatcher';
import { get } from 'appcd-util';

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
			sdk: [],
			visualstudio: {}
		});

		this.timers = {};

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

		await this.initSDK();
		await this.initVS();
	}

	async initSDK() {

		this.sdkDetectEngine = new DetectEngine({
			checkDir(dir) {
				try {
					return new windowslib.SDK(dir);
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

		this.sdkDetectEngine.on('results', results => {
			gawk.set(this.data.sdk, results);
		});

		await this.sdkDetectEngine.start();
	}

	async initVS() {
		let	vswhere = await windowslib.vswhere.getVSWhere();
		if (vswhere) {
			try {
				const { code, stdout, stderr } = await vswhere.detect();
				if (!code) {
					const visualStudios = {};
					const visualStudioData = JSON.parse(stdout);
					for (const vs of visualStudioData) {
						try {
							const visualStudio = new windowslib.VisualStudio(vs);
							visualStudios[vs.installationVersion] = visualStudio;
						} catch (e) {
							console.log(e);
						}
					}
					gawk.set(this.data.visualstudio, visualStudios);
				}
			} catch (e) {
				console.log(e);
			}
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
	 * Executes a detect function, then stores the result and schedules the next check.
	 *
	 * @param {String} type - The bucket name for the detected results.
	 * @param {Number} interval - The amount of milliseconds until the next check.
	 * @param {Function} callback - A function to call that performs the detection.
	 * @returns {Promise}
	 * @access private
	 */
	wireupDetection(type, interval, callback) {
		return callback()
			.then(result => {
				if (result) {
					console.log(`Updating data for ${type}`);
					gawk.set(this.data[type], result);
				}
			})
			.catch(err => {
				console.log(err);
			})
			.then(() => {
				this.timers[type] = setTimeout(() => {
					this.wireupDetection(type, interval, callback);
				}, interval);
			});
	}

	/**
	 * Checks if there are any Visual Studios installed.
	 *
	 * @returns {Boolean}
	 * @access private
	 */
	haveVisualStudio() {
		return Object.keys(this.data.visualstudio).length > 0;
	}

	/**
	 * Detect Windows Phone devices.
	 *
	 * @returns {Promise<Array.<Object>>}
	 * @access private
	 */
	detectDevices() {
		return new Promise((resolve, reject) => {
			if (!this.haveVisualStudio()) {
				return resolve();
			}

			console.log('Detecting devices info');
			windowslib.device.detect({ bypassCache: true }, (err, results) => {
				if (err) {
					reject(err);
				} else {
					const devices = results.devices;
					let wpsdkIndex = -1;
					let realDeviceIndex = -1;
					for (let i = 0; i < devices.length; i++) {
						const device = devices[i];
						if (device.udid === 0 && device.wpsdk) {
							wpsdkIndex = i;
						} else if (device.udid !== 0 && !device.wpsdk) {
							// now find with "real" device
							realDeviceIndex = i;
						}
						if (wpsdkIndex !== -1 && realDeviceIndex !== -1) {
							break;
						}
					}
					if (wpsdkIndex !== -1 && realDeviceIndex !== -1) {
						// set 'real' device wpsdk to the value we got from wptool binary
						devices[realDeviceIndex].wpsdk = devices[wpsdkIndex].wpsdk;
						// remove the wptool binary entry
						devices.splice(wpsdkIndex, 1);
					}
					resolve(devices);
				}
			});
		});
	}

	/**
	 * Detect Windows Phone emulators.
	 *
	 * @returns {Promise<Object>}
	 * @access private
	 */
	detectEmulators() {
		return new Promise((resolve, reject) => {
			if (!this.haveVisualStudio()) {
				return resolve();
			}

			console.log('Detecting emulator info');
			windowslib.emulator.detect({ bypassCache: true }, (err, results) => {
				if (err) {
					reject(err);
				} else {
					resolve(results.emulators);
				}
			});
		});
	}

	/**
	 * Detect Visual Studio installations.
	 *
	 * @returns {Promise<Object>}
	 * @access private
	 */
	detectVisualStudios() {
		return new Promise((resolve, reject) => {
			console.log('Detecting visualstudio info');
			windowslib.visualstudio.detect({ bypassCache: true }, (err, results) => {
				if (err) {
					return reject(err);
				}

				let found = false;
				if (results.visualstudio) {
					for (const visualstudio of Object.keys(results.visualstudio)) {
						if (results.visualstudio[visualstudio].selected) {
							found = true;
							gawk.set(this.data.selectedVisualStudio, results.visualstudio[visualstudio]);
							break;
						}
					}
				}
				if (!found) {
					this.data.selectedVisualStudio = null;
				}

				resolve(results.visualstudio);
			});
		});
	}

	/**
	 * Detect Windows Store SDK information.
	 *
	 * @returns {Promise<Object>}
	 * @access private
	 */
	detectWindowsSDKs() {
		return new Promise((resolve, reject) => {
			console.log('Detecting windows store info');
			windowslib.winstore.detect({ bypassCache: true }, (err, results) => {
				if (err) {
					reject(err);
				} else {
					resolve(results.windows);
				}
			});
		});
	}

	/**
	 * Detect Windows Phone SDK information.
	 *
	 * @returns {Promise<Object>}
	 * @access private
	 */
	detectWindowsPhone() {
		return new Promise((resolve, reject) => {
			console.log('Detecting windowsphone info');
			windowslib.windowsphone.detect({ bypassCache: true }, (err, results) => {
				if (err) {
					reject(err);
				} else {
					resolve(results.windowsphone);
				}
			});
		});
	}
}
