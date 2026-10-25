/* Relay download buttons: label each [data-download] block for the visitor's OS.
 * Load it as a plain (non-deferred) script at the end of <body>, before motion.js, so
 * the label is set before first paint. Markup inside a [data-download] block:
 *   [data-dl-label]   the button text ("Download Relay" -> "Download for macOS")
 *   [data-dl-note]    version line ("v0.2.1 for Windows, macOS and Linux.")
 *   [data-dl-others]  filled with links to the other two platforms
 * Without JS, or on an unknown OS, the generic text in the HTML stays.
 */
(function () {
  "use strict";
  var RELEASES = "https://github.com/CristiMachine25/relay/releases/latest";
  var VERSION = "v0.2.1";
  var ua = navigator.userAgent || "";
  var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
  var os = null;
  if (/android|iphone|ipad|ipod/i.test(ua)) os = "mobile";
  else if (p.indexOf("win") === 0 || /windows/i.test(ua)) os = "windows";
  else if (p.indexOf("mac") === 0 || /mac os x/i.test(ua)) os = "macos";
  else if (p.indexOf("linux") > -1 || /linux|x11|cros/i.test(ua)) os = "linux";
  if (!os) return;

  var names = { windows: "Windows", macos: "macOS", linux: "Linux" };
  var files = { windows: ".exe or .msi", macos: ".dmg for Apple Silicon and Intel", linux: ".AppImage or .deb" };

  function link(text) {
    var a = document.createElement("a");
    a.href = RELEASES;
    a.textContent = text;
    return a;
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-download]"), function (root) {
    var label = root.querySelector("[data-dl-label]");
    var note = root.querySelector("[data-dl-note]");
    var others = root.querySelector("[data-dl-others]");
    if (os === "mobile") {
      if (note) note.textContent = "Relay is a desktop app for Windows, macOS and Linux. Open this page on your computer to install it.";
      return;
    }
    if (label) label.textContent = "Download for " + names[os];
    if (note) note.textContent = VERSION + ", " + files[os] + ".";
    if (others) {
      var rest = Object.keys(names).filter(function (k) { return k !== os; });
      others.textContent = "";
      others.appendChild(document.createTextNode("Also for "));
      others.appendChild(link(names[rest[0]]));
      others.appendChild(document.createTextNode(" and "));
      others.appendChild(link(names[rest[1]]));
      others.appendChild(document.createTextNode("."));
    }
  });
})();
