'use strict';

const WebSocket = require('ws');
const { NotifyIcon, Icon, Menu } = require('not-the-systray');
const fs = require('fs');
const path = require('path');

const GHUB_WS_URL = 'ws://localhost:9010';

//icons are bundled in the executable, but an ico folder placed next to it wins so they stay replaceable
const ICON_DIR = resolveIconDir();

//menu ids 1 and 2 are reserved, device entries start above them to avoid collisions with deviceUnitId
const MENU_ID_EXIT = 1;
const MENU_ID_DEVICES = 2;
const MENU_ID_DEVICE_OFFSET = 100;

const DEVICE_LIST_INTERVAL = 10000;
const RECONNECT_INTERVAL = 5000;

//Shell_NotifyIcon truncates tooltips longer than 127 characters
const TOOLTIP_MAX_LENGTH = 127;

class App {
   constructor() {
      this.deviceManager = new DeviceManager();
      this.tray = new TrayManager(this.deviceManager);

      this.deviceManager.onDevicesChanged = this.tray.update;
      this.deviceManager.start();
   }
}

class TrayManager {
   constructor(deviceManager) {
      this.deviceManager = deviceManager;

      this.handleMenu = this.handleMenu.bind(this);
      this.onSelect = this.onSelect.bind(this);
      this.update = this.update.bind(this);

      this.icons = loadIcons();
      this.icon = new NotifyIcon({
         icon: this.icons.loading,
         tooltip: 'LOADING STATE',
         onSelect: this.onSelect,
      });

      this.trackedDevice = null;
      //pid of each menu entry, indexed the same way as the menu items
      this.menuDevices = [];

      this.menu = new Menu([{ id: MENU_ID_DEVICES, text: 'Set Default Device', items: [] }, { separator: true }, { id: MENU_ID_EXIT, text: 'Exit' }]);
   }

   //rebuilds the device submenu and the tray icon/tooltip from the current device list
   update() {
      const devices = this.deviceManager.getDevices();

      //the tracked device may have been unplugged, fall back to the first one available
      if (this.trackedDevice !== null && !devices.some((device) => device.pid === this.trackedDevice)) {
         this.trackedDevice = null;
      }
      if (this.trackedDevice === null && devices.length > 0) {
         this.trackedDevice = devices[0].pid;
      }

      this.menuDevices = devices.map((device) => device.pid);
      this.menu.update(MENU_ID_DEVICES, {
         items: devices.map((device, index) => ({
            id: MENU_ID_DEVICE_OFFSET + index,
            text: device.displayName + ' (' + device.pid + ')',
            checked: device.pid === this.trackedDevice,
         })),
      });

      this.render(devices);
   }

   //updates text and icon in systray
   render(devices) {
      const known = devices.filter((device) => device.percentage != null);
      const tracked = known.find((device) => device.pid === this.trackedDevice);

      const tooltip = known.length > 0 ? known.map((device) => device.displayName + ' ' + device.percentage + '%').join('\n') : 'No Logitech wireless device found';

      this.icon.update({
         tooltip: tooltip.slice(0, TOOLTIP_MAX_LENGTH),
         icon: tracked ? this.icons[clampPercentage(tracked.percentage)] : this.icons.questionmark,
      });
   }

   //on menu click
   onSelect({ rightButton, mouseX, mouseY }) {
      if (rightButton) {
         this.handleMenu(mouseX, mouseY);
      }
   }

   //handle menu click
   handleMenu(x, y) {
      const id = this.menu.showSync(x, y);

      if (id === MENU_ID_EXIT) {
         this.dispose();
         process.exit(0);
      }

      const pid = this.menuDevices[id - MENU_ID_DEVICE_OFFSET];
      if (pid !== undefined && pid !== this.trackedDevice) {
         this.trackedDevice = pid;
         this.update();
      }
   }

   //removes the tray icon so windows does not leave a ghost entry behind
   dispose() {
      try {
         this.icon.remove();
      } catch (err) {
         //nothing we can do at this point, we are exiting anyway
      }
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
               pid: device.pid,
               deviceUnitId: device.deviceUnitId,
               displayName: device.displayName,
               extendedDisplayName: device.extendedDisplayName,
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

//icons only exist from 1 to 100, a device reporting 0% would otherwise resolve to undefined
function clampPercentage(percentage) {
   return Math.min(100, Math.max(1, Math.round(percentage)));
}

function resolveIconDir() {
   if (process.pkg) {
      const externalDir = path.join(path.dirname(process.execPath), 'ico');
      if (fs.existsSync(externalDir)) return externalDir;
   }

   return path.join(__dirname, 'ico');
}

function loadIcons() {
   const icons = {};

   try {
      for (let i = 1; i <= 100; i++) {
         icons[i] = Icon.load(path.join(ICON_DIR, i + '.ico'), Icon.small);
      }
      icons.questionmark = Icon.load(path.join(ICON_DIR, 'questionmark.ico'), Icon.small);
      icons.loading = Icon.load(path.join(ICON_DIR, 'loading.ico'), Icon.small);
   } catch (err) {
      console.error('Could not load icons from ' + ICON_DIR);
      throw err;
   }

   return icons;
}

const app = new App();

process.on('SIGINT', () => {
   app.tray.dispose();
   process.exit(0);
});
