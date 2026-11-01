// Small helpers for the taskbar.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

// St.BoxLayout swapped `vertical` for `orientation` in GNOME 48.
export function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    if (box.orientation !== undefined)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

// An icon that tries several names, so it looks right in Yaru and Adwaita.
export function themedIcon(names, size, styleClass = '') {
    return new St.Icon({
        gicon: Gio.ThemedIcon.new_from_names(names),
        icon_size: size,
        style_class: styleClass,
    });
}

export function lookupApp(id) {
    return Shell.AppSystem.get_default().lookup_app(id);
}

// Pinned taskbar apps are GNOME's favorites, so the overview dash agrees.
export function getFavorites() {
    return global.settings.get_strv('favorite-apps');
}

export function setFavorite(appId, pinned) {
    const favs = getFavorites().filter(id => id !== appId);
    if (pinned)
        favs.push(appId);
    global.settings.set_strv('favorite-apps', favs);
}

export function isFavorite(appId) {
    return getFavorites().includes(appId);
}


// GNOME 47+ accent colors (libadwaita values).
const GNOME_ACCENTS = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800',
    orange: '#ed5b00', red: '#e62d42', pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
};
// Ubuntu's Yaru theme colors, named by the theme (Yaru-blue-dark and so on).
const YARU_ACCENTS = {
    '': '#e95420', bark: '#787859', sage: '#657b69', olive: '#4b8501', viridian: '#03875b',
    prussiangreen: '#308280', blue: '#0073e5', purple: '#7764d8', magenta: '#b34cb3', red: '#da3450',
};

// The system accent color, kept up to date. Calls onChange when it changes.
export class AccentColor {
    constructor(onChange) {
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const keys = this._settings.settings_schema.list_keys();
        this._hasAccent = keys.includes('accent-color');
        this._ids = ['gtk-theme', ...(this._hasAccent ? ['accent-color'] : [])].map(key =>
            this._settings.connect(`changed::${key}`, () => {
                this._update();
                onChange?.();
            }));
        this._update();
    }

    _update() {
        const theme = this._settings.get_string('gtk-theme');
        const yaru = /^Yaru(?:-([a-z]+))?(?:-dark)?$/i.exec(theme);
        let hex = null;
        if (this._hasAccent) {
            const name = this._settings.get_string('accent-color');
            // Ubuntu keeps its own orange for the "orange" accent.
            hex = name === 'orange' && yaru ? YARU_ACCENTS[''] : GNOME_ACCENTS[name];
        }
        if (!hex && yaru) {
            const name = (yaru[1] ?? '').toLowerCase();
            hex = YARU_ACCENTS[name === 'dark' ? '' : name];
        }
        hex ??= GNOME_ACCENTS.blue;
        this._rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    }

    css(alpha = 1) {
        return `rgba(${this._rgb.join(', ')}, ${alpha})`;
    }

    destroy() {
        this._ids.forEach(id => this._settings.disconnect(id));
        this._ids = [];
    }
}
