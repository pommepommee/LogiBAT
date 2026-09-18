'use strict';

const WebSocket = require('ws');
const { NotifyIcon, Icon, Menu } = require('not-the-systray');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ICON_FILES } = require('./icons');
const { version: APP_VERSION } = require('./package.json');

const GHUB_WS_URL = 'ws://localhost:9010';

const ICON_DIR = resolveIconDir();
const CONFIG_PATH = resolveConfigPath();

//menu ids 1 and 2 are reserved, device entries start above them
const MENU_ID_EXIT = 1;
const MENU_ID_DEVICES = 2;
const MENU_ID_DEVICE_OFFSET = 100;

const DEVICE_LIST_INTERVAL = 10000;
const RECONNECT_INTERVAL = 5000;

//Shell_NotifyIcon truncates tooltips longer than 127 characters
const TOOLTIP_MAX_LENGTH = 127;

class App {
   constructor() {
      this.config = new ConfigStore(CONFIG_PATH);
      this.deviceManager = new DeviceManager();
      this.tray = new TrayManager(this.deviceManager, this.config);

      this.deviceManager.onDevicesChanged = this.tray.update;
      this.deviceManager.start();
      this.tray.update();
   }
}

//remembers which devices the user hid. Hidden ones are stored rather than visible ones, so a device
//that has never been seen shows up on its own and nothing has to be written until something is unchecked.
class ConfigStore {
   constructor(filePath) {
      this.filePath = filePath;
      this.hiddenDevices = new Set(readHiddenDevices(filePath));
   }

   isHidden(deviceUnitId) {
      return this.hiddenDevices.has(deviceUnitId);
   }

   toggle(deviceUnitId) {
      if (!this.hiddenDevices.delete(deviceUnitId)) {
         this.hiddenDevices.add(deviceUnitId);
      }

      this.save();
   }

   //a config that cannot be written is not worth crashing over, the app just forgets the choice
   save() {
      try {
         fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
         fs.writeFileSync(this.filePath, JSON.stringify({ hiddenDevices: [...this.hiddenDevices] }, null, 2));
      } catch (err) {
         console.error('Could not save ' + this.filePath + ': ' + err.message);
      }
   }
}

//creates, updates and removes one tray icon per visible device, plus the permanent control icon
class TrayManager {
   constructor(deviceManager, config) {
      this.deviceManager = deviceManager;
      this.config = config;
      this.update = this.update.bind(this);

      this.icons = loadIcons();
      this.deviceIcons = new Map();

      this.control = new ControlIcon(this.icons, {
         onToggleDevice: (deviceUnitId) => {
            this.config.toggle(deviceUnitId);
            this.update();
         },
         onExit: () => {
            this.dispose();
            process.exit(0);
         },
      });
   }

   update() {
      const devices = this.deviceManager.getDevices();
      const visible = devices.filter((device) => !this.config.isHidden(device.deviceUnitId));

      for (const [deviceUnitId, icon] of this.deviceIcons) {
         if (!visible.some((device) => device.deviceUnitId === deviceUnitId)) {
            icon.dispose();
            this.deviceIcons.delete(deviceUnitId);
         }
      }

      visible.forEach((device) => {
         let icon = this.deviceIcons.get(device.deviceUnitId);
         if (!icon) {
            icon = new DeviceIcon(this.icons);
            this.deviceIcons.set(device.deviceUnitId, icon);
         }

         icon.update(device);
      });

      this.control.update(devices, this.config);
   }

   dispose() {
      this.deviceIcons.forEach((icon) => icon.dispose());
      this.deviceIcons.clear();
      this.control.dispose();
   }
}

//one tray icon showing a single device battery level. Display only, it carries no menu.
class DeviceIcon {
   constructor(icons) {
      this.icons = icons;
      this.icon = new NotifyIcon({ icon: icons.questionmark, tooltip: '' });
   }

   update(device) {
      this.icon.update({
         icon: device.percentage == null ? this.icons.questionmark : this.icons[clampPercentage(device.percentage)],
         tooltip: truncate(device.displayName + ' ' + (device.percentage == null ? '?' : device.percentage + '%')),
      });
   }

   dispose() {
      removeIcon(this.icon);
   }
}

//always present, so the menu stays reachable even when every device is hidden
class ControlIcon {
   constructor(icons, { onToggleDevice, onExit }) {
      this.onToggleDevice = onToggleDevice;
      this.onExit = onExit;
      this.menuDevices = [];

      this.icon = new NotifyIcon({
         icon: icons.logo,
         tooltip: 'LogiBAT',
         onSelect: ({ rightButton, mouseX, mouseY }) => {
            if (rightButton) this.showMenu(mouseX, mouseY);
         },
      });

      this.menu = new Menu([{ id: MENU_ID_DEVICES, text: 'Show icon for', items: [] }, { separator: true }, { id: MENU_ID_EXIT, text: 'Exit' }]);
   }

   update(devices, config) {
      this.menuDevices = devices.map((device) => device.deviceUnitId);

      this.menu.update(MENU_ID_DEVICES, {
         items:
            devices.length > 0
               ? devices.map((device, index) => ({
                    id: MENU_ID_DEVICE_OFFSET + index,
                    text: describe(device),
                    checked: !config.isHidden(device.deviceUnitId),
                 }))
               : [{ id: MENU_ID_DEVICE_OFFSET, text: 'No device found', disabled: true }],
      });

      const known = devices.filter((device) => device.percentage != null);
      this.icon.update({
         tooltip: truncate(known.length > 0 ? known.map((device) => device.displayName + ' ' + device.percentage + '%').join('\n') : 'No Logitech wireless device found'),
      });
   }

   showMenu(x, y) {
      const id = this.menu.showSync(x, y);

      if (id === MENU_ID_EXIT) {
         this.onExit();
         return;
      }

      //the placeholder entry sits at the offset too, but menuDevices is empty when it is shown
      const deviceUnitId = this.menuDevices[id - MENU_ID_DEVICE_OFFSET];
      if (deviceUnitId !== undefined) {
         this.onToggleDevice(deviceUnitId);
      }
   }

   dispose() {
      removeIcon(this.icon);
   }
}

class DeviceManager {
   constructor() {
      this.connect = this.connect.bind(this);
      this.getDeviceList = this.getDeviceList.bind(this);

      this.ws = null;
      this.devices = {};
      this.onDevicesChanged = () => {};
   }

   start() {
      this.connect();
      setInterval(this.getDeviceList, DEVICE_LIST_INTERVAL);
      //automatically reconnects if the hub was not started yet or crashed
      setInterval(this.connect, RECONNECT_INTERVAL);
   }

   getDevices() {
      return Object.values(this.devices);
   }

   connect() {
      if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;

      this.ws = new WebSocket(GHUB_WS_URL, 'json');
      //without a handler, a failed connection would crash the process
      this.ws.on('error', () => {});
      this.ws.on('open', this.getDeviceList);
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('close', () => {
         this.devices = {};
         this.onDevicesChanged();
      });
   }

   //ws throws synchronously when the socket is not open yet, so every send goes through here
   send(payload) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      try {
         this.ws.send(JSON.stringify(payload));
      } catch (err) {
         console.error(err);
      }
   }

   getDeviceList() {
      this.send({ path: '/devices/list', verb: 'GET' });
   }

   requestBatteryState(deviceId) {
      this.send({ path: '/battery/' + deviceId + '/state', verb: 'GET' });
   }

   handleMessage(data) {
      let json;
      try {
         json = JSON.parse(data);
      } catch (err) {
         return;
      }

      if (typeof json.path !== 'string' || !json.result || json.result.code !== 'SUCCESS' || !json.payload) return;

      if (json.path === '/devices/list') {
         this.syncDeviceList(json.payload.deviceInfos || []);
         return;
      }

      if (json.path.startsWith('/battery/') && json.path.endsWith('/state')) {
         const deviceId = json.path.slice('/battery/'.length, -'/state'.length);
         this.updateDeviceBattery(deviceId, json.payload.percentage);
      }
   }

   //merges the incoming list into the known devices, keeping already known battery levels
   syncDeviceList(deviceInfos) {
      const seen = new Set();

      deviceInfos
         .filter((device) => device.connectionType === 'WIRELESS')
         .forEach((device) => {
            seen.add(device.id);

            const known = this.devices[device.id];
            this.devices[device.id] = {
               id: device.id,
               //serial number of the unit: stable across restarts and unique per physical device
               deviceUnitId: device.deviceUnitId,
               displayName: device.displayName,
               deviceType: device.deviceType,
               percentage: known ? known.percentage : null,
            };

            this.requestBatteryState(device.id);
         });

      Object.keys(this.devices).forEach((id) => {
         if (!seen.has(id)) delete this.devices[id];
      });

      this.onDevicesChanged();
   }

   updateDeviceBattery(deviceId, percentage) {
      const device = this.devices[deviceId];
      //battery states of wired devices are ignored, they are not tracked
      if (!device || typeof percentage !== 'number') return;

      device.percentage = percentage;
      this.onDevicesChanged();
   }
}

function describe(device) {
   return device.deviceType ? device.displayName + ' (' + device.deviceType.toLowerCase() + ')' : device.displayName;
}

function truncate(text) {
   return text.slice(0, TOOLTIP_MAX_LENGTH);
}

//icons only exist from 1 to 100, a device reporting 0% would otherwise resolve to undefined
function clampPercentage(percentage) {
   return Math.min(100, Math.max(1, Math.round(percentage)));
}

function removeIcon(icon) {
   try {
      icon.remove();
   } catch (err) {
      //nothing useful to do, the icon is going away either way
   }
}

function resolveIconDir() {
   if (!process.pkg) return path.join(__dirname, 'ico');

   //an ico folder next to the executable wins, so the icons stay replaceable without a rebuild
   const externalDir = path.join(path.dirname(process.execPath), 'ico');

   return fs.existsSync(externalDir) ? externalDir : unpackIcons();
}

//Icon loading ends up in LoadImageW, a native call that cannot see the virtual filesystem pkg
//keeps its assets in, so the icons have to exist as real files. They are unpacked once next to
//the other per-user data, and reused as is afterwards. pkg does the same with native addons.
function unpackIcons() {
   const bundledDir = path.join(__dirname, 'ico');
   const targetDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'LogiBAT', 'ico');
   const stampPath = path.join(targetDir, '.unpacked');
   const stamp = APP_VERSION + ' ' + ICON_FILES.length;

   try {
      if (readTextOrNull(stampPath) !== stamp) {
         fs.mkdirSync(targetDir, { recursive: true });
         ICON_FILES.forEach(({ file }) => fs.writeFileSync(path.join(targetDir, file), fs.readFileSync(path.join(bundledDir, file))));
         //written last, so an interrupted unpack is redone rather than trusted
         fs.writeFileSync(stampPath, stamp);
      }

      return targetDir;
   } catch (err) {
      console.error('Could not unpack the icons to ' + targetDir + ': ' + err.message);

      //loading will fail right after and say so, rather than pretending the icons are elsewhere
      return bundledDir;
   }
}

function readTextOrNull(filePath) {
   try {
      return fs.readFileSync(filePath, 'utf8');
   } catch (err) {
      return null;
   }
}

function resolveConfigPath() {
   return path.join(process.env.APPDATA || os.homedir(), 'LogiBAT', 'config.json');
}

//a missing or unreadable config simply means nothing is hidden
function readHiddenDevices(filePath) {
   try {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(config.hiddenDevices)) return [];

      return config.hiddenDevices.filter((deviceUnitId) => typeof deviceUnitId === 'string');
   } catch (err) {
      return [];
   }
}

function loadIcons() {
   const icons = {};

   try {
      ICON_FILES.forEach(({ key, file }) => {
         icons[key] = Icon.loadFile(path.join(ICON_DIR, file), Icon.small);
      });
   } catch (err) {
      console.error('Could not load the icons from ' + ICON_DIR);
      throw err;
   }

   return icons;
}

const app = new App();

process.on('SIGINT', () => {
   app.tray.dispose();
   process.exit(0);
});
