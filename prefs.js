import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// [format, label]; '' for time means "follow GNOME's 12/24 hour setting".
const timeFormats = () => [
    ['', _('Same as system')],
    ['%H:%M', _('24-hour')],
    ['%-I:%M %p', _('12-hour')],
    ['%H:%M:%S', _('24-hour with seconds')],
    ['%-I:%M:%S %p', _('12-hour with seconds')],
];
const dateFormats = () => [
    ['%x', _('Region default')],
    ['%d/%m/%Y', null],
    ['%m/%d/%Y', null],
    ['%Y-%m-%d', null],
    ['%d.%m.%Y', null],
    ['%a %-d %b', null],
    ['%A, %-d %B %Y', null],
];

export default class WinTaskbarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 760);
        window.add(this._taskbarPage(settings));
        window.add(this._itemsPage(settings));
        window.add(this._clockPage(settings));
    }

    // ---- Taskbar: size, alignment, behaviour -----------------------------

    _taskbarPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Taskbar'), icon_name: 'preferences-desktop-display-symbolic'});

        const size = new Adw.PreferencesGroup({title: _('Size and position')});
        page.add(size);
        size.add(this._spin(settings, 'taskbar-height', _('Bar height'), _('In pixels'), 36, 72, 2));
        size.add(this._spin(settings, 'icon-size', _('Icon size'), _('In pixels'), 16, 64, 2));
        size.add(this._spin(settings, 'background-opacity', _('Background opacity'),
            _('In percent; 0 is fully see-through, 100 is solid'), 0, 100, 5));
        size.add(this._choice(settings, 'alignment', _('Icon alignment'), [
            ['center', _('Center')],
            ['left', _('Left')],
        ]));

        const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(behavior);
        this._switches(settings, behavior, [
            ['current-workspace-only', _('Only show apps from the current workspace'), ''],
            ['hide-top-bar', _('Hide the top bar'), _('Its tray and clock are on the taskbar')],
            ['hide-ubuntu-dock', _('Turn off the Ubuntu Dock'),
                _('It comes back when you turn this off or disable the taskbar')],
            ['blur', _('Blur behind the taskbar'), _('Uses more graphics power')],
        ]);
        return page;
    }

    // ---- Which buttons and icons show ------------------------------------

    _itemsPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Icons'), icon_name: 'view-grid-symbolic'});

        const buttons = new Adw.PreferencesGroup({title: _('Taskbar buttons')});
        page.add(buttons);
        this._switches(settings, buttons, [
            ['show-start-button', _('Ubuntu button'), _('Opens the app grid')],
            ['show-task-view', _('Task View'), _('Opens the overview with all windows and workspaces')],
            ['show-pinned-apps', _('Pinned apps'),
                _('Off: only running apps are shown. Right-click an app to pin or unpin it')],
            ['show-desktop-button', _('Show desktop'), _('The thin strip at the far right')],
        ]);

        const tray = new Adw.PreferencesGroup({title: _('System tray'),
            description: _('Items you turn off stay in the top bar.')});
        page.add(tray);
        const trayRow = this._switch(settings, 'show-tray', _('Show the system tray'),
            _('Network, sound, battery and the system menu'));
        tray.add(trayRow);
        const spacingRow = this._spin(settings, 'tray-spacing', _('Space between tray icons'),
            _('In pixels'), 0, 32, 1);
        tray.add(spacingRow);
        const trayItems = [
            ['show-keyboard-indicator', _('Keyboard layout'), ''],
            ['show-a11y-indicator', _('Accessibility'), ''],
            ['show-app-indicators', _('App icons'), _('Icons added by apps and other extensions')],
        ].map(([key, title, subtitle]) => {
            const row = this._switch(settings, key, title, subtitle);
            tray.add(row);
            return row;
        });
        trayItems.push(spacingRow);
        const syncTray = () => trayItems.forEach(r => (r.sensitive = settings.get_boolean('show-tray')));
        settings.connect('changed::show-tray', syncTray);
        syncTray();

        page.add(this._trayIconsGroup(settings));
        return page;
    }

    // App tray icons: always shown on the taskbar, or hidden behind ^.
    _trayIconsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('App icons in the tray'),
            description: _('Turn on the icons you always want to see. The others are hidden ' +
                'behind the ^ button next to the tray. Apps appear here once their icon has been shown.'),
        });
        let rows = [];
        const build = () => {
            rows.forEach(r => group.remove(r));
            rows = [];
            const known = settings.get_strv('tray-known').map(e => e.split('\t'));
            const shown = settings.get_strv('tray-shown');
            if (!known.length) {
                const empty = new Adw.ActionRow({title: _('No app icons seen yet'),
                    subtitle: _('Open an app that puts an icon in the tray, then come back here')});
                group.add(empty);
                rows.push(empty);
                return;
            }
            for (const [key, label] of known) {
                const row = new Adw.SwitchRow({title: label || key, subtitle: label && label !== key ? key : '',
                    active: shown.includes(key)});
                row.connect('notify::active', () => {
                    const list = settings.get_strv('tray-shown').filter(k => k !== key);
                    if (row.active)
                        list.push(key);
                    settings.set_strv('tray-shown', list);
                });
                group.add(row);
                rows.push(row);
            }
        };
        settings.connect('changed::tray-known', build);
        build();
        return group;
    }

    // ---- Clock ------------------------------------------------------------

    _clockPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Clock'), icon_name: 'preferences-system-time-symbolic'});
        const group = new Adw.PreferencesGroup({title: _('Clock')});
        page.add(group);

        const show = this._switch(settings, 'show-clock', _('Show the clock'),
            _('Clicking it opens the calendar and notifications'));
        group.add(show);

        const details = new Adw.PreferencesGroup({title: _('Format'),
            description: _('Custom formats use strftime codes, for example %H:%M or %d/%m/%Y.')});
        page.add(details);

        const now = GLib.DateTime.new_now_local();
        const timeChoices = timeFormats().map(([f, label]) =>
            [f, f ? `${label}  (${now.format(f)})` : label]);
        details.add(this._formatRow(settings, 'time-format', _('Time'), timeChoices, now));

        details.add(this._switch(settings, 'show-date', _('Show the date'), _('Under the time')));
        const dateChoices = dateFormats().map(([f, label]) =>
            [f, label ? `${label}  (${now.format(f)})` : now.format(f)]);
        details.add(this._formatRow(settings, 'date-format', _('Date'), dateChoices, now));

        const font = new Adw.SpinRow({
            title: _('Text size'),
            subtitle: _('In points; 0 uses the default'),
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 0.5}),
        });
        settings.bind('clock-font-size', font, 'value', Gio.SettingsBindFlags.DEFAULT);
        details.add(font);

        const syncClock = () => (details.sensitive = settings.get_boolean('show-clock'));
        settings.connect('changed::show-clock', syncClock);
        syncClock();
        return page;
    }

    // A dropdown of presets plus "Custom", which shows a text box.
    _formatRow(settings, key, title, presets, now) {
        const expander = new Adw.ExpanderRow({title});
        const labels = [...presets.map(([, label]) => label), _('Custom')];
        const combo = new Adw.ComboRow({title: _('Format'), model: Gtk.StringList.new(labels)});
        const entry = new Adw.EntryRow({title: _('Custom format'), show_apply_button: true});
        expander.add_row(combo);
        expander.add_row(entry);

        let updating = false;
        const sync = () => {
            updating = true;
            const value = settings.get_string(key);
            const index = presets.findIndex(([f]) => f === value);
            combo.selected = index >= 0 ? index : presets.length;
            entry.text = value;
            entry.visible = index < 0;
            const preview = value ? GLib.DateTime.new_now_local().format(value) : null;
            expander.subtitle = index >= 0 ? presets[index][1] : `${value}  (${preview ?? _('invalid')})`;
            updating = false;
        };
        combo.connect('notify::selected', () => {
            if (updating)
                return;
            if (combo.selected < presets.length) {
                settings.set_string(key, presets[combo.selected][0]);
            } else {
                // Custom: start from the current value and let them edit it.
                entry.visible = true;
                entry.grab_focus();
            }
        });
        entry.connect('apply', () => {
            const text = entry.text.trim();
            if (text && now.format(text) === null) {
                entry.add_css_class('error');
                return;
            }
            entry.remove_css_class('error');
            settings.set_string(key, text);
        });
        settings.connect(`changed::${key}`, sync);
        sync();
        return expander;
    }

    _choice(settings, key, title, options) {
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(([, l]) => l))});
        const sync = () => {
            const index = options.findIndex(([v]) => v === settings.get_string(key));
            row.selected = Math.max(index, 0);
        };
        row.connect('notify::selected', () => {
            const value = options[row.selected]?.[0];
            if (value && value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        settings.connect(`changed::${key}`, sync);
        sync();
        return row;
    }

    _spin(settings, key, title, subtitle, lower, upper, step) {
        const row = new Adw.SpinRow({title, subtitle,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step})});
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _switches(settings, group, rows) {
        for (const [key, title, subtitle] of rows)
            group.add(this._switch(settings, key, title, subtitle));
    }
}
