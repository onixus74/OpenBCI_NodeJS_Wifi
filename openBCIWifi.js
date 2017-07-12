'use strict';
const EventEmitter = require('events').EventEmitter;
const _ = require('lodash');
const util = require('util');
// Local imports
const OpenBCIUtilities = require('openbci-utilities');
const obciUtils = OpenBCIUtilities.Utilities;
const k = OpenBCIUtilities.Constants;
const obciDebug = OpenBCIUtilities.Debug;
const clone = require('clone');
const ip = require('ip');

const wifiOutputModeJSON = 'json';
const wifiOutputModeRaw = 'raw';
const defaultChannelSettingsArray = k.channelSettingsArrayInit(k.OBCINumberOfChannelsDefault);


const _options = {
  debug: false,
  sendCounts: false,
  simulate: false,
  simulatorBoardFailure: false,
  simulatorHasAccelerometer: true,
  simulatorInternalClockDrift: 0,
  simulatorInjectAlpha: true,
  simulatorInjectLineNoise: [k.OBCISimulatorLineNoiseHz60, k.OBCISimulatorLineNoiseHz50, k.OBCISimulatorLineNoiseNone],
  simulatorSampleRate: 200,
  verbose: false
};

/**
 * @description The initialization method to call first, before any other method.
 * @param options {object} (optional) - Board optional configurations.
 *     - `debug` {Boolean} - Print out a raw dump of bytes sent and received. (Default `false`)
 *
 *     - `sendCounts` {Boolean} - Send integer raw counts instead of scaled floats.
 *           (Default `false`)
 *
 *     - `simulate` {Boolean} - (IN-OP) Full functionality, just mock data. Must attach Daisy module by setting
 *                  `simulatorDaisyModuleAttached` to `true` in order to get 16 channels. (Default `false`)
 *
 *     - `simulatorBoardFailure` {Boolean} - (IN-OP)  Simulates board communications failure. This occurs when the RFduino on
 *                  the board is not polling the RFduino on the dongle. (Default `false`)
 *
 *     - `simulatorHasAccelerometer` - {Boolean} - Sets simulator to send packets with accelerometer data. (Default `true`)
 *
 *     - `simulatorInjectAlpha` - {Boolean} - Inject a 10Hz alpha wave in Channels 1 and 2 (Default `true`)
 *
 *     - `simulatorInjectLineNoise` {String} - Injects line noise on channels.
 *          3 Possible Options:
 *              `60Hz` - 60Hz line noise (Default) [America]
 *              `50Hz` - 50Hz line noise [Europe]
 *              `none` - Do not inject line noise.
 *
 *     - `simulatorSampleRate` {Number} - The sample rate to use for the simulator. Simulator will set to 125 if
 *                  `simulatorDaisyModuleAttached` is set `true`. However, setting this option overrides that
 *                  setting and this sample rate will be used. (Default is `250`)
 *
 *     - `verbose` {Boolean} - Print out useful debugging events. (Default `false`)
 * @param callback {function} (optional) - A callback function used to determine if the noble module was able to be started.
 *    This can be very useful on Windows when there is no compatible BLE device found.
 * @constructor
 * @author AJ Keller (@pushtheworldllc)
 */
function Wifi (options, callback) {
  if (!(this instanceof Wifi)) {
    return new Wifi(options, callback);
  }

  if (options instanceof Function) {
    callback = options;
    options = {};
  }

  options = (typeof options !== 'function') && options || {};
  let opts = {};

  /** Configuring Options */
  let o;
  for (o in _options) {
    var userOption = (o in options) ? o : o.toLowerCase();
    var userValue = options[userOption];
    delete options[userOption];

    if (typeof _options[o] === 'object') {
      // an array specifying a list of choices
      // if the choice is not in the list, the first one is defaulted to

      if (_options[o].indexOf(userValue) !== -1) {
        opts[o] = userValue;
      } else {
        opts[o] = _options[o][0];
      }
    } else {
      // anything else takes the user value if provided, otherwise is a default

      if (userValue !== undefined) {
        opts[o] = userValue;
      } else {
        opts[o] = _options[o];
      }
    }
  }

  for (o in options) throw new Error('"' + o + '" is not a valid option');

  // Set to global options object
  this.options = clone(opts);

  /** Private Properties (keep alphabetical) */
  this._accelArray = [0, 0, 0];
  this._connected = false;
  this._droppedPacketCounter = 0;
  this._firstPacket = true;
  this._localName = null;
  this._multiPacketBuffer = null;
  this._packetCounter = 0;
  this._peripheral = null;
  this._scanning = false;
  this._streaming = false;

  /** Public Properties (keep alphabetical) */
  this.peripheralArray = [];
  this.wifiPeripheralArray = [];
  this.previousPeripheralArray = [];
  this.manualDisconnect = false;
  this.curOutputMode = wifiOutputModeRaw;

  /** Initializations */

  this.wifiInitServer();
  if (callback) callback();
}

// This allows us to use the emitter class freely outside of the module
util.inherits(Wifi, EventEmitter);

/**
 * @description Send a command to the board to turn a specified channel off
 * @param channelNumber
 * @returns {Promise.<T>}
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.channelOff = function (channelNumber) {
  return k.commandChannelOff(channelNumber).then((charCommand) => {
    // console.log('sent command to turn channel ' + channelNumber + ' by sending command ' + charCommand)
    return this.write(charCommand);
  });
};

/**
 * @description Send a command to the board to turn a specified channel on
 * @param channelNumber
 * @returns {Promise.<T>|*}
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.channelOn = function (channelNumber) {
  return k.commandChannelOn(channelNumber).then((charCommand) => {
    // console.log('sent command to turn channel ' + channelNumber + ' by sending command ' + charCommand)
    return this.write(charCommand);
  });
};

/**
 * @description The essential precursor method to be called initially to establish a
 *              ble connection to the OpenBCI ganglion board.
 * @param id {String | Object} - a string local name or peripheral object
 * @returns {Promise} If the board was able to connect.
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.connect = function (id) {
  return new Promise((resolve, reject) => {
    this.wifiConnectSocket(id, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

/**
 * Destroys the noble!
 */
Wifi.prototype.destroyNoble = function () {
  this._nobleDestroy();
};

/**
 * Destroys the multi packet buffer.
 */
Wifi.prototype.destroyMultiPacketBuffer = function () {
  this._multiPacketBuffer = null;
};

/**
 * @description Closes the connection to the board. Waits for stop streaming command to
 *  be sent if currently streaming.
 * @param stopStreaming {Boolean} (optional) - True if you want to stop streaming before disconnecting.
 * @returns {Promise} - fulfilled by a successful close, rejected otherwise.
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.disconnect = function (stopStreaming) {
  // no need for timeout here; streamStop already performs a delay
  return Promise.resolve()
    .then(() => {
      if (stopStreaming) {
        if (this.isStreaming()) {
          if (this.options.verbose) console.log('stop streaming');
          return this.streamStop();
        }
      }
      return Promise.resolve();
    })
    .then(() => {
      return new Promise((resolve, reject) => {
        // serial emitting 'close' will call _disconnected
        if (this._peripheral) {
          this._peripheral.disconnect((err) => {
            if (err) {
              this._disconnected();
              reject(err);
            } else {
              this._disconnected();
              resolve();
            }
          });
        } else {
          reject('no peripheral to disconnect');
        }
      });
    });
};

/**
 * Return the local name of the attached Wifi device.
 * @return {null|String}
 */
Wifi.prototype.getLocalName = function () {
  return this._localName;
};

/**
 * Get's the multi packet buffer.
 * @return {null|Buffer} - Can be null if no multi packets received.
 */
Wifi.prototype.getMutliPacketBuffer = function () {
  return this._multiPacketBuffer;
};

/**
 * @description Checks if the driver is connected to a board.
 * @returns {boolean} - True if connected.
 */
Wifi.prototype.isConnected = function () {
  return this._connected;
};

/**
 * @description Checks if noble is currently scanning.
 * @returns {boolean} - True if streaming.
 */
Wifi.prototype.isSearching = function () {
  return this._scanning;
};

/**
 * @description Checks if the board is currently sending samples.
 * @returns {boolean} - True if streaming.
 */
Wifi.prototype.isStreaming = function () {
  return this._streaming;
};

/**
 * @description This function is used as a convenience method to determine how many
 *              channels the current board is using.
 * @returns {Number} A number
 * Note: This is dependent on if you configured the board correctly on setup options
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.numberOfChannels = function () {
  return k.OBCINumberOfChannelsDefault;
};

/**
 * @description Get the the current sample rate is.
 * @returns {Number} The sample rate
 * Note: This is dependent on if you configured the board correctly on setup options
 */
Wifi.prototype.sampleRate = function () {
  if (this.options.simulate) {
    return this.options.simulatorSampleRate;
  } else {
    return k.OBCISampleRate200;
  }
};

/**
 * @description List available peripherals so the user can choose a device when not
 *              automatically found.
 * @param `maxSearchTime` {Number} - The amount of time to spend searching. (Default is 20 seconds)
 * @returns {Promise} - If scan was started
 */
Wifi.prototype.searchStart = function (maxSearchTime) {
  const searchTime = maxSearchTime || k.OBCIWifiBleSearchTime;

  return new Promise((resolve, reject) => {
    this._searchTimeout = setTimeout(() => {
      this._nobleScanStop().catch(reject);
      reject('Timeout: Unable to find Wifi');
    }, searchTime);

    this._nobleScanStart()
      .then(() => {
        resolve();
      })
      .catch((err) => {
        if (err !== k.OBCIErrorNobleAlreadyScanning) { // If it's already scanning
          clearTimeout(this._searchTimeout);
          reject(err);
        }
      });
  });
};

/**
 * Called to end a search.
 * @return {global.Promise|Promise}
 */
Wifi.prototype.searchStop = function () {
  return this._nobleScanStop();
};

/**
 * @description Sends a soft reset command to the board
 * @returns {Promise} - Fulfilled if the command was sent to board.
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.softReset = function () {
  return this.write(k.OBCIMiscSoftReset);
};

/**
 * @description Sends a start streaming command to the board.
 * @returns {Promise} indicating if the signal was able to be sent.
 * Note: You must have successfully connected to an OpenBCI board using the connect
 *           method. Just because the signal was able to be sent to the board, does not
 *           mean the board will start streaming.
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.streamStart = function () {
  return new Promise((resolve, reject) => {
    if (this.isStreaming()) return reject('Error [.streamStart()]: Already streaming');
    this._streaming = true;
    this.write(k.OBCIStreamStart)
      .then(() => {
        if (this.options.verbose) console.log('Sent stream start to board.');
        resolve();
      })
      .catch(reject);
  });
};

/**
 * @description Sends a stop streaming command to the board.
 * @returns {Promise} indicating if the signal was able to be sent.
 * Note: You must have successfully connected to an OpenBCI board using the connect
 *           method. Just because the signal was able to be sent to the board, does not
 *           mean the board stopped streaming.
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.streamStop = function () {
  return new Promise((resolve, reject) => {
    if (!this.isStreaming()) return reject('Error [.streamStop()]: No stream to stop');
    this._streaming = false;
    this.write(k.OBCIStreamStop)
      .then(() => {
        resolve();
      })
      .catch(reject);
  });
};

/**
 * @description Puts the board in synthetic data generation mode. Must call streamStart still.
 * @returns {Promise} indicating if the signal was able to be sent.
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.syntheticEnable = function () {
  return new Promise((resolve, reject) => {
    this.write(k.OBCIWifiSyntheticDataEnable)
      .then(() => {
        if (this.options.verbose) console.log('Enabled synthetic data mode.');
        resolve();
      })
      .catch(reject);
  });
};

/**
 * @description Takes the board out of synthetic data generation mode. Must call streamStart still.
 * @returns {Promise} - fulfilled if the command was sent.
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.syntheticDisable = function () {
  return new Promise((resolve, reject) => {
    this.write(k.OBCIWifiSyntheticDataDisable)
      .then(() => {
        if (this.options.verbose) console.log('Disabled synthetic data mode.');
        resolve();
      })
      .catch(reject);
  });
};

/**
 * @description Used to send data to the board.
 * @param data {Array | Buffer | Number | String} - The data to write out
 * @returns {Promise} - fulfilled if command was able to be sent
 * @author AJ Keller (@pushtheworldllc)
 */
Wifi.prototype.write = function (data) {
  return new Promise((resolve, reject) => {
    if (this._peripheral) {
      if (!Buffer.isBuffer(data)) {
        data = new Buffer(data);
      }
      if (this.options.debug) obciDebug.debugBytes('>>>', data);
      this.post()
      this._sendCharacteristic.write(data);
      resolve();
    } else {
      reject('Send characteristic not set, please call connect method');
    }
  });
};

// //////// //
// PRIVATES //
// //////// //


/**
 * @description Called once when for any reason the ble connection is no longer open.
 * @private
 */
Wifi.prototype._disconnected = function () {
  this._streaming = false;
  this._connected = false;

  // Clean up _noble
  // TODO: Figure out how to fire function on process ending from inside module
  // noble.removeListener('discover', this._nobleOnDeviceDiscoveredCallback);

  if (this._receiveCharacteristic) {
    this._receiveCharacteristic.removeAllListeners(k.OBCINobleEmitterServiceRead);
  }

  this._receiveCharacteristic = null;

  if (this._rfduinoService) {
    this._rfduinoService.removeAllListeners(k.OBCINobleEmitterServiceCharacteristicsDiscover);
  }

  this._rfduinoService = null;

  if (this._peripheral) {
    this._peripheral.removeAllListeners(k.OBCINobleEmitterPeripheralConnect);
    this._peripheral.removeAllListeners(k.OBCINobleEmitterPeripheralDisconnect);
    this._peripheral.removeAllListeners(k.OBCINobleEmitterPeripheralServicesDiscover);
  }

  this._peripheral = null;

  if (!this.manualDisconnect) {
    // this.autoReconnect();
  }

  if (this.options.verbose) console.log(`Private disconnect clean up`);

  this.emit('close');
};

/**
 * Route incoming data to proper functions
 * @param data {Buffer} - Data buffer from noble Wifi.
 * @private
 */
Wifi.prototype._processBytes = function (data) {
  if (this.options.debug) obciDebug.debugBytes('<<', data);
  if (this.curOutputMode === wifiOutputModeRaw) {
    if (this.buffer) {
      this.buffer = new Buffer([this.buffer, data]);
    } else {
      this.buffer = data;
    }
    const output = obciUtils.extractRawDataPackets(this.buffer);

    this.buffer = output.buffer;
    const samples = obciUtils.transformRawDataPacketsToSample(output.rawDataPackets)
  }
};

/**
 * Process an compressed packet of data.
 * @param data {Buffer}
 *  Data packet buffer from noble.
 * @private
 */
Wifi.prototype._processCompressedData = function (data) {
  // Save the packet counter
  this._packetCounter = parseInt(data[0]);

  // Decompress the buffer into array
  if (this._packetCounter <= k.OBCIWifiByteId18Bit.max) {
    this._decompressSamples(obciUtils.decompressDeltas18Bit(data.slice(k.OBCIWifiPacket18Bit.dataStart, k.OBCIWifiPacket18Bit.dataStop)));
    switch (this._packetCounter % 10) {
      case k.OBCIWifiAccelAxisX:
        this._accelArray[0] = this.options.sendCounts ? data.readInt8(k.OBCIWifiPacket18Bit.auxByte - 1) : data.readInt8(k.OBCIWifiPacket18Bit.auxByte - 1) * k.OBCIWifiAccelScaleFactor;
        break;
      case k.OBCIWifiAccelAxisY:
        this._accelArray[1] = this.options.sendCounts ? data.readInt8(k.OBCIWifiPacket18Bit.auxByte - 1) : data.readInt8(k.OBCIWifiPacket18Bit.auxByte - 1) * k.OBCIWifiAccelScaleFactor;
        break;
      case k.OBCIWifiAccelAxisZ:
        this._accelArray[2] = this.options.sendCounts ? data.readInt8(k.OBCIWifiPacket18Bit.auxByte - 1) : data.readInt8(k.OBCIWifiPacket18Bit.auxByte - 1) * k.OBCIWifiAccelScaleFactor;
        this.emit(k.OBCIEmitterAccelerometer, this._accelArray);
        break;
      default:
        break;
    }
    const sample1 = this._buildSample(this._packetCounter * 2 - 1, this._decompressedSamples[1]);
    this.emit(k.OBCIEmitterSample, sample1);

    const sample2 = this._buildSample(this._packetCounter * 2, this._decompressedSamples[2]);
    this.emit(k.OBCIEmitterSample, sample2);

  } else {
    this._decompressSamples(obciUtils.decompressDeltas19Bit(data.slice(k.OBCIWifiPacket19Bit.dataStart, k.OBCIWifiPacket19Bit.dataStop)));

    const sample1 = this._buildSample((this._packetCounter - 100) * 2 - 1, this._decompressedSamples[1]);
    this.emit(k.OBCIEmitterSample, sample1);

    const sample2 = this._buildSample((this._packetCounter - 100) * 2, this._decompressedSamples[2]);
    this.emit(k.OBCIEmitterSample, sample2);
  }

  // Rotate the 0 position for next time
  for (let i = 0; i < k.OBCINumberOfChannelsWifi; i++) {
    this._decompressedSamples[0][i] = this._decompressedSamples[2][i];
  }
};

/**
 * Process and emit an impedance value
 * @param data {Buffer}
 * @private
 */
Wifi.prototype._processImpedanceData = function (data) {
  if (this.options.debug) obciDebug.debugBytes('Impedance <<< ', data);
  const byteId = parseInt(data[0]);
  let channelNumber;
  switch (byteId) {
    case k.OBCIWifiByteIdImpedanceChannel1:
      channelNumber = 1;
      break;
    case k.OBCIWifiByteIdImpedanceChannel2:
      channelNumber = 2;
      break;
    case k.OBCIWifiByteIdImpedanceChannel3:
      channelNumber = 3;
      break;
    case k.OBCIWifiByteIdImpedanceChannel4:
      channelNumber = 4;
      break;
    case k.OBCIWifiByteIdImpedanceChannelReference:
      channelNumber = 0;
      break;
  }

  let output = {
    channelNumber: channelNumber,
    impedanceValue: 0
  };

  let end = data.length;

  while (_.isNaN(Number(data.slice(1, end))) && end !== 0) {
    end--;
  }

  if (end !== 0) {
    output.impedanceValue = Number(data.slice(1, end));
  }

  this.emit('impedance', output);
};

/**
 * Used to stack multi packet buffers into the multi packet buffer. This is finally emitted when a stop packet byte id
 *  is received.
 * @param data {Buffer}
 *  The multi packet buffer.
 * @private
 */
Wifi.prototype._processMultiBytePacket = function (data) {
  if (this._multiPacketBuffer) {
    this._multiPacketBuffer = Buffer.concat([this._multiPacketBuffer, data.slice(k.OBCIWifiPacket19Bit.dataStart, k.OBCIWifiPacket19Bit.dataStop)]);
  } else {
    this._multiPacketBuffer = data.slice(k.OBCIWifiPacket19Bit.dataStart, k.OBCIWifiPacket19Bit.dataStop);
  }
};

/**
 * Adds the `data` buffer to the multi packet buffer and emits the buffer as 'message'
 * @param data {Buffer}
 *  The multi packet stop buffer.
 * @private
 */
Wifi.prototype._processMultiBytePacketStop = function (data) {
  this._processMultiBytePacket(data);
  this.emit(k.OBCIEmitterMessage, this._multiPacketBuffer);
  this.destroyMultiPacketBuffer();
};

Wifi.prototype._resetDroppedPacketSystem = function () {
  this._packetCounter = -1;
  this._firstPacket = true;
  this._droppedPacketCounter = 0;
};

Wifi.prototype._droppedPacket = function (droppedPacketNumber) {
  this.emit(k.OBCIEmitterDroppedPacket, [droppedPacketNumber]);
  this._droppedPacketCounter++;
};

/**
 * Checks for dropped packets
 * @param data {Buffer}
 * @private
 */
Wifi.prototype._processProcessSampleData = function(data) {
  const curByteId = parseInt(data[0]);
  const difByteId = curByteId - this._packetCounter;

  if (this._firstPacket) {
    this._firstPacket = false;
    this._processRouteSampleData(data);
    return;
  }

  // Wrap around situation
  if (difByteId < 0) {
    if (this._packetCounter <= k.OBCIWifiByteId18Bit.max) {
      if (this._packetCounter === k.OBCIWifiByteId18Bit.max) {
        if (curByteId !== k.OBCIWifiByteIdUncompressed) {
          this._droppedPacket(curByteId - 1);
        }
      } else {
        let tempCounter = this._packetCounter + 1;
        while (tempCounter <= k.OBCIWifiByteId18Bit.max) {
          this._droppedPacket(tempCounter);
          tempCounter++;
        }
      }
    } else if (this._packetCounter === k.OBCIWifiByteId19Bit.max) {
      if (curByteId !== k.OBCIWifiByteIdUncompressed) {
        this._droppedPacket(curByteId - 1);
      }
    } else {
      let tempCounter = this._packetCounter + 1;
      while (tempCounter <= k.OBCIWifiByteId19Bit.max) {
        this._droppedPacket(tempCounter);
        tempCounter++;
      }
    }
  } else if (difByteId > 1) {
    if (this._packetCounter === k.OBCIWifiByteIdUncompressed && curByteId === k.OBCIWifiByteId19Bit.min) {
      this._processRouteSampleData(data);
      return;
    } else {
      let tempCounter = this._packetCounter + 1;
      while (tempCounter < curByteId) {
        this._droppedPacket(tempCounter);
        tempCounter++;
      }
    }
  }
  this._processRouteSampleData(data);
};

Wifi.prototype._processRouteSampleData = function(data) {
  if (parseInt(data[0]) === k.OBCIWifiByteIdUncompressed) {
    this._processUncompressedData(data);
  } else {
    this._processCompressedData(data);
  }
};

/**
 * The default route when a ByteId is not recognized.
 * @param data {Buffer}
 * @private
 */
Wifi.prototype._processOtherData = function (data) {
  obciDebug.debugBytes('OtherData <<< ', data);
};

/**
 * Process an uncompressed packet of data.
 * @param data {Buffer}
 *  Data packet buffer from noble.
 * @private
 */
Wifi.prototype._processUncompressedData = function (data) {
  let start = 1;

  // Resets the packet counter back to zero
  this._packetCounter = k.OBCIWifiByteIdUncompressed;  // used to find dropped packets
  for (let i = 0; i < 4; i++) {
    this._decompressedSamples[0][i] = interpret24bitAsInt32(data, start);  // seed the decompressor
    start += 3;
  }

  const newSample = this._buildSample(0, this._decompressedSamples[0]);
  this.emit(k.OBCIEmitterSample, newSample);
};

Wifi.prototype.wifiConnectSocket = function (shieldIP, cb) {
  this.curParsingMode = k.OBCIParsingNormal;
  this.post(shieldIP, '/tcp', {
    ip: ip.address(),
    output: this.curOutputMode,
    port: this.wifiGetLocalPort(),
    delimiter: false,
    latency: "1000"
  }, cb);
};

Wifi.prototype.wifiClientCreate = function () {
  this.wifiClient = new ssdp({});
};

Wifi.prototype.wifiDestroy = function () {
  this.wifiServer = null;
  if (this.wifiClient) {
    this.wifiClient.stop();
  }
  this.wifiClient = null;
};

Wifi.prototype.wifiFindShieldsStart = function (timeout, attempts) {
  this.wifiClient = new ssdp({});
  let attemptCounter = 0;
  let _attempts = attempts || 2;
  let _timeout = timeout || 5 * 1000;
  let timeoutFunc = () => {
    if (attemptCounter < _attempts) {
      this.wifiClient.stop();
      this.wifiClient.search('urn:schemas-upnp-org:device:Basic:1');
      attemptCounter++;
      if (this.options.verbose) console.log(`SSDP: still trying to find a board - attempt ${attemptCounter} of ${_attempts}`);
      this.ssdpTimeout = setTimeout(timeoutFunc, _timeout);
    } else {
      this.wifiClient.stop();
      clearTimeout(this.ssdpTimeout);
      if (this.options.verbose) console.log('SSDP: stopping because out of attemps');
    }
  };
  this.wifiClient.on('response', (headers, code, rinfo) => {
    if (this.options.verbose) console.log('SSDP:Got a response to an m-search:\n%d\n%s\n%s', code, JSON.stringify(headers, null, '  '), JSON.stringify(rinfo, null, '  '));
    this.emit('wifiShield', { headers, code, rinfo });
  });
  // Search for just the wifi shield
  this.wifiClient.search('urn:schemas-upnp-org:device:Basic:1');
  this.ssdpTimeout = setTimeout(timeoutFunc, _timeout);
};

Wifi.prototype.wifiFindShieldsStop = function () {
  if (this.wifiClient) this.wifiClient.stop();
  if (this.ssdpTimeout) clearTimeout(this.ssdpTimeout);
};

Wifi.prototype.wifiGetLocalPort = function () {
  return this.wifiServer.address().port;
};

Wifi.prototype.wifiInitServer = function () {
  let persistentBuffer = null;
  const delimBuf = new Buffer("\r\n");
  this.wifiServer = net.createServer((socket) => {
    streamJSON.on("data", (sample) => {
      console.log(sample);
    });
    socket.on('data', (data) => {
      // this._processBytes(data);
      console.log(data.toString());
      streamJSON.write(data);
      // if (persistentBuffer !== null) persistentBuffer = Buffer.concat([persistentBuffer, data]);
      // else persistentBuffer = data;
      //
      // if (persistentBuffer) {
      //   let bytesIn = persistentBuffer.byteLength;
      //   if (bytesIn > 2) {
      //     let head = 2;
      //     let tail = 0;
      //     while (head < bytesIn - 2) {
      //       if (delimBuf.compare(persistentBuffer, head-2, head) === 0) {
      //         try {
      //           const obj = JSON.parse(persistentBuffer.slice(tail, head-2));
      //           console.log(obj.chunk);
      //           if (head < bytesIn - 2) {
      //             tail = head;
      //           }
      //         } catch (e) {
      //           console.log(persistentBuffer.slice(tail, head-2).toString());
      //           persistentBuffer = persistentBuffer.slice(head);
      //           return;
      //         }
      //
      //       }
      //       head++;
      //     }
      //
      //     if (tail < bytesIn - 2) {
      //       persistentBuffer = persistentBuffer.slice(tail);
      //     } else {
      //       persistentBuffer = null;
      //     }
      //
      //   }
      // }

    });
    socket.on('error', (err) => {
      if (this.options.verbose) console.log('SSDP:',err);
    });
  }).listen();
  if (this.options.verbose) console.log("Server on port: ", this.wifiGetLocalPort());
};

Wifi.prototype.wifiProcessResponse = function (res, cb) {
  if (this.options.verbose) {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
  }
  res.setEncoding('utf8');
  let msg = '';
  res.on('data', (chunk) => {
    if (this.options.verbose) console.log(`BODY: ${chunk}`);
    msg += chunk.toString();
  });
  res.once('end', () => {
    if (this.options.verbose) console.log('No more data in response.');
    this.emit('res', msg);
    if (res.statusCode !== 200) {
      if (cb) cb(msg);
    } else {
      if (cb) cb();
    }
  });
};

Wifi.prototype.post = function (host, path, payload, cb) {
  const output = JSON.stringify(payload);
  const options = {
    host: host,
    port: 80,
    path: path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': output.length
    }
  };

  const req = http.request(options, (res) => {
    this.wifiProcessResponse(res, (err) => {
      if (err) {
        if (cb) cb(err);
      } else {
        if (cb) cb();
      }
    });
  });

  req.once('error', (e) => {
    if (this.options.verbose) console.log(`problem with request: ${e.message}`);
    if (cb) cb(e);
  });

  // write data to request body
  req.write(output);
  req.end();
};

module.exports = Wifi;