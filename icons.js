'use strict';

//The one list of icons the app needs, used both to load them and to unpack them out of the
//packaged executable.
const ICON_FILES = [];

for (let i = 1; i <= 100; i++) {
   ICON_FILES.push({ key: i, file: i + '.ico' });
}

ICON_FILES.push({ key: 'questionmark', file: 'questionmark.ico' });
ICON_FILES.push({ key: 'loading', file: 'loading.ico' });
ICON_FILES.push({ key: 'logo', file: 'logo.ico' });

module.exports = { ICON_FILES };
