// Win Taskbar: a Windows-style taskbar for GNOME Shell.
//
// A bottom bar with an Ubuntu button for the app grid, pinned and running
// apps with window previews, the system tray and a clock. It runs inside GNOME Shell, so it
// works the same on Wayland and X11.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Taskbar} from './taskbar.js';

// Docks that would sit on top of the taskbar.
const DOCKS = ['ubuntu-dock@ubuntu.com', 'dash-to-dock@micxgx.gmail.com'];
// Internal bookkeeping; changing it needs no rebuild.
const QUIET_KEYS = ['docks-to-restore', 'app-order', 'tray-known'];

export default class WinTaskbarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._build();
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (QUIET_KEYS.includes(key))
                return;
            this._queueRebuild();
        });
        this._dockIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._dockIdleId = 0;
            this._syncDocks();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        for (const name of ['_rebuildId', '_dockIdleId']) {
            if (this[name]) {
                GLib.source_remove(this[name]);
                this[name] = 0;
            }
        }
        this._settings.disconnect(this._settingsId);
        this._teardown();

        // The user turned the taskbar off (not just the screen locking):
        // give them their dock back.
        if (!Main.sessionMode.isLocked && Main.sessionMode.currentMode === 'user')
            this._restoreDocks();
        this._settings = null;
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildId = 0;
            this._teardown();
            this._build();
            this._syncDocks();
            return GLib.SOURCE_REMOVE;
        });
    }

    _build() {
        this._taskbar = new Taskbar(this._settings, () => this.openPreferences());
        if (this._settings.get_boolean('hide-top-bar'))
            this._hideTopBar();
    }

    _teardown() {
        this._showTopBar();
        this._taskbar?.destroy();
        this._taskbar = null;
    }

    // ---- Top bar ----------------------------------------------------------
    // Its tray and clock now live in the taskbar, so hide what is left and
    // give the space back to windows.

    _hideTopBar() {
        const box = Main.layoutManager.panelBox;
        if (this._topBarHidden || !box)
            return;
        Main.layoutManager.untrackChrome(box);
        box.hide();
        this._topBarHidden = true;
    }

    _showTopBar() {
        if (!this._topBarHidden)
            return;
        const box = Main.layoutManager.panelBox;
        box.show();
        Main.layoutManager.trackChrome(box, {affectsStruts: true, trackFullscreen: true});
        this._topBarHidden = false;
    }

    // ---- Ubuntu Dock ------------------------------------------------------

    _isEnabled(uuid) {
        if (!Main.extensionManager.lookup(uuid))
            return false;
        if (global.settings.get_strv('disabled-extensions').includes(uuid))
            return false;
        return global.settings.get_strv('enabled-extensions').includes(uuid) ||
            (Main.sessionMode.enabledExtensions ?? []).includes(uuid);
    }

    _syncDocks() {
        if (!this._settings.get_boolean('hide-ubuntu-dock')) {
            this._restoreDocks();
            return;
        }
        const toRestore = this._settings.get_strv('docks-to-restore');
        for (const uuid of DOCKS) {
            if (!this._isEnabled(uuid))
                continue;
            try {
                Main.extensionManager.disableExtension(uuid);
                if (!toRestore.includes(uuid))
                    toRestore.push(uuid);
            } catch (e) {
                console.warn(`win-taskbar: could not turn off ${uuid}: ${e.message}`);
            }
        }
        this._settings.set_strv('docks-to-restore', toRestore);
    }

    _restoreDocks() {
        const toRestore = this._settings.get_strv('docks-to-restore');
        if (!toRestore.length)
            return;
        for (const uuid of toRestore) {
            try {
                Main.extensionManager.enableExtension(uuid);
            } catch (e) {
                console.warn(`win-taskbar: could not turn ${uuid} back on: ${e.message}`);
            }
        }
        this._settings.set_strv('docks-to-restore', []);
    }
}
