/* global WebTorrent, angular, moment, prompt */

// ─── Constants ───────────────────────────────────────────────────────────────

const VERSION = '1.1'

// WebSocket trackers used to announce and find peers.
// wss:// (WebSocket Secure) trackers are required for WebRTC-based torrenting
// in browsers, as plain UDP/TCP tracker protocols are not available.
const trackers = ['wss://tracker.btorrent.xyz', 'wss://tracker.openwebtorrent.com']

// ICE server configuration passed to WebRTC for NAT traversal.
// STUN servers allow peers behind NAT to discover their public IP/port.
// Without this, peers on different networks would fail to connect.
const rtcConfig = {
  'iceServers': [
    {
      'urls': ['stun:stun.l.google.com:19305', 'stun:stun1.l.google.com:19305']
    }
  ]
}

// Options passed to client.add() / client.seed() for every torrent operation.
// The announce list tells WebTorrent which trackers to use for this torrent.
const torrentOpts = {
  announce: trackers
}

// Options passed to the WebTorrent client constructor. Includes both the
// tracker announce list and the WebRTC peer connection configuration.
const trackerOpts = {
  announce: trackers,
  rtcConfig: rtcConfig
}

// ─── Debug Logging ───────────────────────────────────────────────────────────

// Enable verbose debug output by running in the browser console:
//   localStorage.setItem('debug', '1')
// Disable with:
//   localStorage.removeItem('debug')
const debug = window.localStorage.getItem('debug') !== null

// dbg(string, item, color): logs a styled console.debug message when debug mode
// is on. item can be a WebTorrent torrent or file object; its name and infoHash
// are included in the log prefix for easy identification.
const dbg = function (string, item, color) {
  // Use loose inequality (!= null) so that both null and undefined fall back
  // to the default colour. Strict (!== null) would leave color as undefined
  // when the argument is omitted, producing "color: undefined" in the log.
  color = color != null ? color : '#333333'
  if (debug) {
    if (item && item.name) {
      return console.debug(`%cβTorrent:${item.infoHash !== null ? 'torrent ' : 'torrent ' + item._torrent.name + ':file '}${item.name}${item.infoHash !== null ? ' (' + item.infoHash + ')' : ''} %c${string}`, 'color: #33C3F0', `color: ${color}`)
    } else {
      return console.debug(`%cβTorrent:client %c${string}`, 'color: #33C3F0', `color: ${color}`)
    }
  }
}

// er(err, item): shorthand for logging errors in red via dbg().
const er = function (err, item) { dbg(err, item, '#FF0000') }

dbg(`Starting v${VERSION}. WebTorrent ${WebTorrent.VERSION}`)

// ─── WebTorrent Client ───────────────────────────────────────────────────────

// Single shared WebTorrent client instance for the whole application.
// Created outside Angular so it persists across route changes (controller
// re-instantiations would otherwise create duplicate clients).
const client = new WebTorrent({
  tracker: trackerOpts
})

// ─── Angular Module ───────────────────────────────────────────────────────────

const app = angular.module('BTorrent',
  // Declare module dependencies:
  // ngRoute   — client-side routing between Full / Download / View modes
  // ui.grid   — torrent data table with sortable, resizable columns
  // ngFileUpload — file picker directive (ngf-select) used on buttons
  // ngNotify  — toast notification service
  ['ngRoute', 'ui.grid', 'ui.grid.resizeColumns', 'ui.grid.selection', 'ngFileUpload', 'ngNotify'],
  ['$compileProvider', '$locationProvider', '$routeProvider', function ($compileProvider, $locationProvider, $routeProvider) {
    // By default AngularJS strips href values it considers unsafe. This whitelist
    // adds magnet: and blob: URIs so they can be used in ng-href without being
    // replaced with "unsafe:...".
    $compileProvider.aHrefSanitizationWhitelist(/^\s*(https?|magnet|blob|javascript):/)

    // Enable HTML5 pushState routing so URLs look like /download instead of /#/download.
    // requireBase: false means Angular doesn't require a <base> tag (though one is
    // present in index.html). hashPrefix('#') sets the fallback hash character.
    $locationProvider.html5Mode({
      enabled: true,
      requireBase: false
    }).hashPrefix('#')

    // Route definitions: each URL maps to a template and a controller.
    $routeProvider.when('/view', {
      templateUrl: 'views/view.html',
      controller: 'ViewCtrl'
    }).when('/download', {
      templateUrl: 'views/download.html',
      controller: 'DownloadCtrl'
    }).otherwise({
      templateUrl: 'views/full.html',
      controller: 'FullCtrl'
    })
  }]
)

// ─── BTorrentCtrl ─────────────────────────────────────────────────────────────
// Root controller attached to <body>. Owns:
//   - The shared WebTorrent client reference on $rootScope
//   - The 500ms UI refresh interval
//   - All torrent lifecycle callbacks (onTorrent, onSeed, destroyedTorrent)
//   - Input handlers used by all three views (addMagnet, seedFiles, openTorrentFile)
//   - File priority management (changePriority)

app.controller('BTorrentCtrl', ['$scope', '$rootScope', '$http', '$log', '$location', 'ngNotify', function ($scope, $rootScope, $http, $log, $location, ngNotify) {
  let updateAll
  $rootScope.version = VERSION
  $rootScope.webtorrentVersion = WebTorrent.VERSION

  // Configure toast notifications: 5 seconds duration, allow HTML content in
  // messages (used to bold file names in download-ready notifications).
  ngNotify.config({
    duration: 5000,
    html: true
  })

  // Disable the UI entirely if the browser does not support WebRTC.
  // WebTorrent.WEBRTC_SUPPORT is false in environments without RTCPeerConnection
  // (e.g., very old browsers or certain server-side runtimes).
  if (!WebTorrent.WEBRTC_SUPPORT) {
    $rootScope.disabled = true
    ngNotify.set('Please use a WebRTC compatible browser', {
      type: 'error',
      sticky: true,
      button: false
    })
  }

  // Expose the shared WebTorrent client on $rootScope so all views and child
  // controllers can access client.torrents, client.downloadSpeed, etc.
  $rootScope.client = client

  // ── UI Refresh Interval ──────────────────────────────────────────────────
  // WebTorrent updates torrent stats (speed, progress, peers) outside of
  // Angular's digest cycle. We manually trigger $apply() every 500ms so the
  // template bindings (speed, ETA, progress bars) stay current.
  updateAll = function () {
    // Skip this tick if WebTorrent is mid-operation to avoid updating the UI
    // with an incomplete/transient state.
    if ($rootScope.client.processing) {
      return
    }
    // Guard against "digest already in progress" error. $rootScope.$$phase is
    // set to '$apply' or '$digest' while Angular is running a cycle. Calling
    // $apply() during an active cycle throws an error that is especially
    // frequent in Firefox due to its JS scheduler timing. Skip if non-null.
    if (!$rootScope.$$phase) {
      $rootScope.$apply()
    }
  }
  setInterval(updateAll, 500)

  // ── seedFiles(files) ─────────────────────────────────────────────────────
  // Called by the ngf-select directive when the user picks files to seed.
  // For multiple files, prompts the user for a torrent name before seeding.
  $rootScope.seedFiles = function (files) {
    let name
    if ((files != null) && files.length > 0) {
      if (files.length === 1) {
        dbg(`Seeding file ${files[0].name}`)
      } else {
        dbg(`Seeding ${files.length} files`)
        name = prompt('Please name your torrent', 'My Awesome Torrent') || 'My Awesome Torrent'
        torrentOpts.name = name
      }
      $rootScope.client.processing = true
      $rootScope.client.seed(files, torrentOpts, $rootScope.onSeed)
      // Remove the temporary name so it doesn't affect future single-file seeds.
      delete torrentOpts.name
    }
  }

  // ── openTorrentFile(file) ────────────────────────────────────────────────
  // Called by ngf-select when the user picks a .torrent file from disk.
  // Passes the File object directly to client.add() which reads its binary
  // metadata without uploading it anywhere.
  $rootScope.openTorrentFile = function (file) {
    if (file != null) {
      dbg(`Adding torrent file ${file.name}`)
      $rootScope.client.processing = true
      $rootScope.client.add(file, torrentOpts, $rootScope.onTorrent)
    }
  }

  // Surface WebTorrent client-level errors as toast notifications.
  $rootScope.client.on('error', function (err, torrent) {
    $rootScope.client.processing = false
    ngNotify.set(err, 'error')
    er(err, torrent)
  })

  // ── addMagnet(magnet, onTorrent) ─────────────────────────────────────────
  // Adds a magnet URI, raw info hash, or http(s) .torrent URL to the client.
  // An optional onTorrent callback overrides the default; ViewCtrl uses this
  // to pass its own handler that calls file.appendTo() for in-browser streaming.
  $rootScope.addMagnet = function (magnet, onTorrent) {
    if ((magnet != null) && magnet.length > 0) {
      dbg(`Adding magnet/hash ${magnet}`)
      $rootScope.client.processing = true
      $rootScope.client.add(magnet, torrentOpts, onTorrent || $rootScope.onTorrent)
    }
  }

  // ── destroyedTorrent(err) ────────────────────────────────────────────────
  // Callback passed to torrent.destroy(). Clears the selected torrent and
  // resets the processing flag so the spinner is hidden.
  $rootScope.destroyedTorrent = function (err) {
    if (err) {
      throw err
    }
    dbg('Destroyed torrent', $rootScope.selectedTorrent)
    $rootScope.selectedTorrent = null
    $rootScope.client.processing = false
  }

  // ── changePriority(file) ─────────────────────────────────────────────────
  // Called by the priority <select> ng-change handler in the files table.
  // Priority '-1' deselects the file (pauses its download); any other value
  // re-selects it at the given priority level (0 = normal, 1 = high).
  $rootScope.changePriority = function (file) {
    if (file.priority === '-1') {
      dbg('Deselected', file)
      file.deselect()
    } else {
      dbg(`Selected with priority ${file.priority}`, file)
      file.select(file.priority)
    }
  }

  // ── onTorrent(torrent, isSeed) ───────────────────────────────────────────
  // Invoked when WebTorrent has received metadata for a torrent (either from
  // a peer or because we are the seeder). Sets up the torrent's share URLs and
  // kicks off getBlobURL() for each file so download links can be shown in the UI.
  $rootScope.onTorrent = function (torrent, isSeed) {
    dbg(torrent.magnetURI)

    // torrentFileBlobURL is a blob: URL pointing to the raw .torrent file binary,
    // generated by WebTorrent v1 from the parsed metadata. We alias it through
    // safeTorrentFileURL so the template's aHrefSanitizationWhitelist allows it.
    torrent.safeTorrentFileURL = torrent.torrentFileBlobURL
    torrent.fileName = `${torrent.name}.torrent`

    if (!isSeed) {
      dbg('Received metadata', torrent)
      ngNotify.set(`Received ${torrent.name} metadata`)
      // Auto-select the first torrent that completes metadata if none is
      // currently selected, so the detail panel appears immediately.
      if (!($rootScope.selectedTorrent != null)) {
        $rootScope.selectedTorrent = torrent
      }
      $rootScope.client.processing = false
    }

    // For each file in the torrent, request a blob: URL from WebTorrent.
    // getBlobURL() streams the file into memory and calls back with a URL
    // that can be used in an <a download> link. The file.url property is
    // watched by the template and the link appears once file.done is true.
    torrent.files.forEach(function (file) {
      file.getBlobURL(function (err, url) {
        if (err) {
          throw err
        }
        if (isSeed) {
          dbg('Started seeding', torrent)
          if (!($rootScope.selectedTorrent != null)) {
            $rootScope.selectedTorrent = torrent
          }
          $rootScope.client.processing = false
        }
        file.url = url
        if (!isSeed) {
          dbg('Done ', file)
          ngNotify.set(`<b>${file.name}</b> ready for download`, 'success')
        }
      })
    })

    // 'done' fires when all files have been fully downloaded.
    torrent.on('done', function () {
      if (!isSeed) {
        dbg('Done', torrent)
      }
      ngNotify.set(`<b>${torrent.name}</b> has finished downloading`, 'success')
    })

    // Log each new peer wire connection in debug mode.
    torrent.on('wire', function (wire, addr) { dbg(`Wire ${addr}`, torrent) })
    torrent.on('error', er)
  }

  // onSeed is a thin wrapper that calls onTorrent with isSeed=true, which
  // suppresses the "metadata received" notification and shows a seeding message.
  $rootScope.onSeed = function (torrent) { $rootScope.onTorrent(torrent, true) }

  dbg('Ready')
}
])

// ─── FullCtrl ─────────────────────────────────────────────────────────────────
// Controller for views/full.html — the main multi-torrent management view.
// Owns the ui-grid configuration and row selection logic. Also reads the URL
// fragment (#infoHash) on load to auto-start a torrent from a shared link.

app.controller('FullCtrl', ['$scope', '$rootScope', '$http', '$log', '$location', 'ngNotify', function ($scope, $rootScope, $http, $log, $location, ngNotify) {
  ngNotify.config({
    duration: 5000,
    html: true
  })

  // addMagnet() is the form submit handler for the magnet/hash input field.
  // It delegates to $rootScope.addMagnet() and clears the input.
  $scope.addMagnet = function () {
    $rootScope.addMagnet($scope.torrentInput)
    $scope.torrentInput = ''
  }

  // ── Grid Column Definitions ──────────────────────────────────────────────
  // Each entry maps a WebTorrent torrent property to a ui-grid column.
  // cellFilter applies an Angular filter to the raw value before display.
  // width values are in pixels; minWidth prevents columns from collapsing.
  $scope.columns = [
    {
      field: 'name',
      cellTooltip: true,   // Show full name on hover when truncated
      minWidth: '200'
    }, {
      field: 'length',
      name: 'Size',
      cellFilter: 'pbytes', // Convert bytes to human-readable (e.g. "42.3 MB")
      width: '80'
    }, {
      field: 'received',
      displayName: 'Downloaded',
      cellFilter: 'pbytes',
      width: '135'
    }, {
      field: 'downloadSpeed',
      displayName: '↓ Speed',
      cellFilter: 'pbytes:1', // :1 = speed mode, appends "/s"
      width: '100'
    }, {
      field: 'progress',
      displayName: 'Progress',
      cellFilter: 'progress', // Converts 0–1 float to "42.0%"
      width: '100'
    }, {
      field: 'timeRemaining',
      displayName: 'ETA',
      cellFilter: 'humanTime', // Converts milliseconds to "About 2 hours"
      width: '140'
    }, {
      field: 'uploaded',
      displayName: 'Uploaded',
      cellFilter: 'pbytes',
      width: '125'
    }, {
      field: 'uploadSpeed',
      displayName: '↑ Speed',
      cellFilter: 'pbytes:1',
      width: '100'
    }, {
      field: 'numPeers',
      displayName: 'Peers',
      width: '80'
    }, {
      field: 'ratio',
      cellFilter: 'number:2', // Two decimal places
      width: '80'
    }
  ]

  // ── Grid Options ─────────────────────────────────────────────────────────
  // data is bound directly to the live client.torrents array; ui-grid watches
  // it and re-renders when torrents are added or removed.
  $scope.gridOptions = {
    columnDefs: $scope.columns,
    data: $rootScope.client.torrents,
    enableColumnResizing: true,
    enableColumnMenus: false,
    enableRowSelection: true,
    enableRowHeaderSelection: false, // No separate checkbox column
    multiSelect: false               // Only one torrent selected at a time
  }

  // ── Row Selection Handler ────────────────────────────────────────────────
  $scope.gridOptions.onRegisterApi = function (gridApi) {
    $scope.gridApi = gridApi
    gridApi.selection.on.rowSelectionChanged($scope, function (row) {
      // When a row is deselected, clear selectedTorrent only if the deselected
      // row corresponds to the currently selected torrent. Uses === (strict
      // equality) to compare infoHash strings. Previously used = (assignment)
      // which always evaluated truthy, so deselecting never cleared the panel.
      if (!row.isSelected && ($rootScope.selectedTorrent != null) && ($rootScope.selectedTorrent.infoHash === row.entity.infoHash)) {
        $rootScope.selectedTorrent = null
      } else {
        $rootScope.selectedTorrent = row.entity
      }
    })
  }

  // ── URL Fragment Auto-load ───────────────────────────────────────────────
  // If the page was opened with a URL fragment (e.g. btorrent.xyz/#<infoHash>),
  // auto-start that torrent. setTimeout(fn, 0) defers until after Angular's
  // initial digest so the controller and client are fully ready.
  if ($location.hash() !== '') {
    $rootScope.client.processing = true
    setTimeout(function () {
      dbg(`Adding ${$location.hash()}`)
      $rootScope.addMagnet($location.hash())
    }, 0)
  }
}
])

// ─── DownloadCtrl ─────────────────────────────────────────────────────────────
// Controller for views/download.html — a simplified single-download view.
// Exposes the same addMagnet() form handler as FullCtrl and supports the same
// URL-fragment auto-load behaviour.

app.controller('DownloadCtrl', ['$scope', '$rootScope', '$http', '$log', '$location', 'ngNotify', function ($scope, $rootScope, $http, $log, $location, ngNotify) {
  ngNotify.config({
    duration: 5000,
    html: true
  })

  $scope.addMagnet = function () {
    $rootScope.addMagnet($scope.torrentInput)
    $scope.torrentInput = ''
  }

  // Auto-load torrent from URL fragment (same pattern as FullCtrl).
  if ($location.hash() !== '') {
    $rootScope.client.processing = true
    setTimeout(function () {
      dbg(`Adding ${$location.hash()}`)
      $rootScope.addMagnet($location.hash())
    }, 0)
  }
}
])

// ─── ViewCtrl ─────────────────────────────────────────────────────────────────
// Controller for views/view.html — a media streaming / in-browser preview mode.
// Uses a local onTorrent callback (instead of $rootScope.onTorrent) so it can
// call file.appendTo('#viewer') to embed media elements directly in the page.

app.controller('ViewCtrl', ['$scope', '$rootScope', '$http', '$log', '$location', 'ngNotify', function ($scope, $rootScope, $http, $log, $location, ngNotify) {
  let onTorrent
  ngNotify.config({
    duration: 2000,
    html: true
  })

  // Local onTorrent callback: differs from the global one in that it calls
  // file.appendTo('#viewer') to inject a <video>/<audio>/<img> into the DOM
  // for immediate in-browser playback, rather than just generating a download link.
  onTorrent = function (torrent) {
    // Expand the viewer div by removing top margin and centering its content.
    $rootScope.viewerStyle = {
      'margin-top': '-20px',
      'text-align': 'center'
    }
    dbg(torrent.magnetURI)

    // Set up share URLs (same as the global onTorrent handler).
    torrent.safeTorrentFileURL = torrent.torrentFileBlobURL
    torrent.fileName = `${torrent.name}.torrent`

    $rootScope.selectedTorrent = torrent
    $rootScope.client.processing = false
    dbg('Received metadata', torrent)
    ngNotify.set(`Received ${torrent.name} metadata`)

    torrent.files.forEach(function (file) {
      // appendTo() streams the file into a media element and appends it to the
      // specified selector. Supports video, audio, and image MIME types.
      file.appendTo('#viewer')

      // Also generate a blob: URL so the file can be saved if needed.
      file.getBlobURL(function (err, url) {
        if (err) {
          throw err
        }
        file.url = url
        dbg('Done ', file)
      })
    })

    torrent.on('done', function () { dbg('Done', torrent) })
    torrent.on('wire', function (wire, addr) { dbg(`Wire ${addr}`, torrent) })
    torrent.on('error', er)
  }

  $scope.addMagnet = function () {
    $rootScope.addMagnet($scope.torrentInput, onTorrent)
    $scope.torrentInput = ''
  }

  // Auto-load torrent from URL fragment, using the local streaming onTorrent.
  if ($location.hash() !== '') {
    $rootScope.client.processing = true
    setTimeout(function () {
      dbg(`Adding ${$location.hash()}`)
      $rootScope.addMagnet($location.hash(), onTorrent)
    }, 0)
  }
}
])

// ─── Filters ──────────────────────────────────────────────────────────────────

// html filter: marks a string as trusted HTML so Angular's $sce does not escape
// it when rendered via ng-bind-html. Used for notification messages that contain
// bold tags (e.g. "<b>file.name</b> ready for download").
// Note: the return statement is required; omitting it causes the filter to always
// produce undefined, rendering nothing in the template.
app.filter('html', [
  '$sce', function ($sce) {
    return function (input) {
      return $sce.trustAsHtml(input)
    }
  }
])

// pbytes filter: converts a raw byte count to a human-readable string.
// When speed=truthy (e.g. pbytes:1), appends "/s" for display as a data rate.
// Examples: 1500 → "1.5 kB", 1500 with speed → "1.5 kB/s"
app.filter('pbytes', function () {
  return function (num, speed) {
    let exponent, unit, units
    if (isNaN(num)) {
      return ''
    }
    units = ['B', 'kB', 'MB', 'GB', 'TB']
    if (num < 1) {
      return (speed ? '' : '0 B')
    }
    // log(num) / log(1000) gives the SI prefix exponent (0=B, 1=kB, 2=MB, …)
    // Clamped to 4 (TB) so the units array is never overrun.
    exponent = Math.min(Math.floor(Math.log(num) / 6.907755278982137), 8)
    num = (num / Math.pow(1000, exponent)).toFixed(1) * 1
    unit = units[exponent]
    return `${num} ${unit}${speed ? '/s' : ''}`
  }
})

// humanTime filter: converts a duration in milliseconds to a natural-language
// string using moment.js. Returns '' for durations under 1 second (shown as
// blank in the ETA column when a torrent has just started or is already done).
// Example: 7380000 → "About 2 hours"
app.filter('humanTime', function () {
  return function (millis) {
    let remaining
    if (millis < 1000) {
      return ''
    }
    remaining = moment.duration(millis).humanize()
    // Capitalise the first letter for display ("About…" not "about…").
    return remaining[0].toUpperCase() + remaining.substr(1)
  }
})

// progress filter: converts a 0–1 progress fraction to a percentage string
// with one decimal place. Example: 0.4271 → "42.7%"
app.filter('progress', function () { return function (num) { return `${(100 * num).toFixed(1)}%` } })
