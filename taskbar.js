// The bottom bar: the Ubuntu button, Task View, pinned and running apps, the system
// tray and clock (moved down from the top bar), and Show desktop.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {vbox, themedIcon, lookupApp, getFavorites, isFavorite, setFavorite, AccentColor} from './utils.js';

// Top bar items that are always moved down: the system menu and the
// indicators GNOME shows only while something is happening.
const SYSTEM_ROLES = ['quickSettings', 'dwellClick', 'screenRecording', 'screenSharing'];
const HOVER_SHOW_MS = 400;
const HOVER_HIDE_MS = 250;
const PREVIEW_W = 220;
const PREVIEW_H = 130;
const MAX_PREVIEWS = 8;

export class Taskbar {
    constructor(settings, openPrefs) {
        this._settings = settings;
        this._openPrefs = openPrefs;
        this._dragging = null;
        this._placeholder = null;
        this.accent = new AccentColor(() => this._buttons.forEach(b => b.update()));
        this._signals = [];
        this._windowSignals = new Map();
        this._buttons = new Map();
        this._runningOrder = [];
        this._syncId = 0;
        this._adopted = [];
        this._height = settings.get_int('taskbar-height');
        this._iconSize = settings.get_int('icon-size');
        this._buttonWidth = Math.max(this._height, this._iconSize + 16);

        this.actor = new TaskbarBox({style_class: 'wtb-taskbar', reactive: true, name: 'winTaskbar'});
        if (settings.get_boolean('blur'))
            this.addBlur(this.actor);
        const opacity = settings.get_int('background-opacity') / 100;
        this.actor.style = `background-color: rgba(30, 30, 34, ${opacity});`;

        this._leftBox = new St.BoxLayout({style_class: 'wtb-left'});
        this._centerBox = new St.BoxLayout({style_class: 'wtb-center'});
        this._rightBox = new St.BoxLayout({style_class: 'wtb-right'});
        this.actor.setBoxes(this._leftBox, this._centerBox, this._rightBox);

        // The Ubuntu button, Task View and the app buttons sit together, in the middle
        // like Windows 11 or on the left like Windows 10.
        this._taskBox = new St.BoxLayout({style_class: 'wtb-tasks', y_expand: true});
        const home = settings.get_string('alignment') === 'left' ? this._leftBox : this._centerBox;
        home.add_child(this._taskBox);

        if (settings.get_boolean('show-start-button')) {
            this._startButton = this._buildStartButton();
            this._taskBox.add_child(this._startButton);
        }

        if (settings.get_boolean('show-task-view')) {
            const taskView = this._iconButton(['view-dual-symbolic', 'focus-windows-symbolic', 'view-grid-symbolic'],
                _('Task View'), () => {
                    if (Main.overview.visible)
                        Main.overview.hide();
                    else
                        Main.overview.show();
                });
            this._taskBox.add_child(taskView);
        }

        this._appsBox = new St.BoxLayout({style_class: 'wtb-apps', y_expand: true});
        this._taskBox.add_child(this._appsBox);
        // The line between pinned and unpinned apps, as on the Ubuntu Dock.
        this._separator = new St.Widget({style_class: 'wtb-separator', width: 1,
            height: Math.round(this._height * 0.5), y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._appsBox.add_child(this._separator);

        // Tray, left to right: app icons that are always shown, the ^
        // button for the hidden ones, then GNOME's own system icons.
        this._trayBox = new St.BoxLayout({style_class: 'wtb-tray', y_expand: true});
        this._appTrayBox = new St.BoxLayout({style_class: 'wtb-tray-apps', y_expand: true});
        this._systemTrayBox = new St.BoxLayout({style_class: 'wtb-tray-system', y_expand: true});
        const spacing = settings.get_int('tray-spacing');
        for (const box of [this._trayBox, this._appTrayBox, this._systemTrayBox])
            box.style = `spacing: ${spacing}px;`;
        this._trayBox.add_child(this._appTrayBox);
        this._rightBox.add_child(this._trayBox);
        if (settings.get_boolean('show-desktop-button')) {
            this._desktopButton = new St.Button({style_class: 'wtb-show-desktop', y_expand: true,
                accessible_name: _('Show desktop'), reactive: true, track_hover: true});
            this._desktopButton.connect('clicked', () => this._toggleDesktop());
            this._rightBox.add_child(this._desktopButton);
        }

        this.menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._previews = new PreviewPopup(this);
        this._overflow = new TrayOverflow(this);

        // Anything dragged over the bar (our buttons, or apps from the app
        // grid) ends up here.
        this.actor._delegate = {
            handleDragOver: source => this.handleDragOver(source),
            acceptDrop: source => this.acceptDrop(source),
        };
        this.actor.connect('button-release-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            const target = event.get_source?.() ?? global.stage.get_event_actor?.(event);
            const empty = [this.actor, this._leftBox, this._centerBox, this._rightBox,
                this._taskBox, this._appsBox, this._trayBox, this._appTrayBox, this._systemTrayBox];
            if (target && !empty.includes(target))
                return Clutter.EVENT_PROPAGATE;
            this._openBarMenu();
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.addChrome(this.actor, {affectsStruts: true, trackFullscreen: true});
        this._place();

        this._adoptTray();
        this._adoptDateMenu();
        this._connectSignals();
        this._sync();
    }

    get top() {
        return this.actor.y;
    }

    get iconSize() {
        return this._iconSize;
    }

    get buttonWidth() {
        return this._buttonWidth;
    }

    addBlur(actor) {
        try {
            const blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: 0.7});
            if ('radius' in blur)
                blur.radius = 40;
            else
                blur.sigma = 20;
            actor.add_effect(blur);
        } catch (e) {
            console.warn(`win-taskbar: blur is not available: ${e.message}`);
        }
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.actor.set_position(monitor.x, monitor.y + monitor.height - this._height);
        this.actor.set_size(monitor.width, this._height);
    }

    // Ubuntu's logo; opens Ubuntu's own app grid, like the dock's
    // Show Applications button.
    _buildStartButton() {
        const button = new St.Button({style_class: 'wtb-button wtb-start-button', can_focus: true,
            y_expand: true, accessible_name: _('Show Applications'), width: this._buttonWidth,
            child: themedIcon(['start-here-symbolic', 'distributor-logo-symbolic', 'ubuntu-logo-icon',
                'start-here', 'distributor-logo', 'view-app-grid-symbolic'], this._iconSize)});
        button.connect('clicked', () => {
            if (Main.overview.visible)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
        return button;
    }

    _iconButton(names, label, callback) {
        const button = new St.Button({style_class: 'wtb-button', can_focus: true, y_expand: true,
            width: this._buttonWidth, accessible_name: label,
            child: themedIcon(names, Math.round(this._iconSize * 0.85))});
        button.connect('clicked', callback);
        return button;
    }

    // ---- Tray and clock, borrowed from the top bar ------------------------

    _adoptTray() {
        const source = Main.panel._rightBox;
        if (!source)
            return;
        this._traySource = source;
        this._trayBox.add_child(this._overflow.chevron);
        this._trayBox.add_child(this._systemTrayBox);
        for (const child of source.get_children()) {
            if (this._wantsInTray(child))
                this._adopt(child, -1);
        }
        this._rememberTrayIcons();
        // Indicators added later (for example by an app-indicator extension)
        // land in the top bar, so move them down too.
        this._trayAddedId = source.connect('child-added', (_box, child) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._traySource && child.get_parent() === source && this._wantsInTray(child)) {
                    this._adopt(child, 0);
                    this._rememberTrayIcons();
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // Items left out stay in the top bar, which is hidden by default.
    _wantsInTray(container) {
        if (!this._settings.get_boolean('show-tray'))
            return false;
        const statusArea = Main.panel.statusArea ?? {};
        const role = Object.keys(statusArea).find(r => statusArea[r]?.container === container);
        if (!role || SYSTEM_ROLES.includes(role))
            return true;
        if (role === 'keyboard')
            return this._settings.get_boolean('show-keyboard-indicator');
        if (role === 'a11y')
            return this._settings.get_boolean('show-a11y-indicator');
        return this._settings.get_boolean('show-app-indicators');
    }

    _adopt(child, index) {
        child.get_parent()?.remove_child(child);
        const key = trayKey(child);
        // App icons not chosen to be always shown go behind the ^ button.
        if (key && !this._settings.get_strv('tray-shown').includes(key))
            this._overflow.add(child, index);
        else if (key)
            this._appTrayBox.insert_child_at_index(child, index);
        else
            this._systemTrayBox.insert_child_at_index(child, index);
        this._adopted.push(child);
        setArrowSide(child.child, St.Side.BOTTOM);
    }

    // Lets the settings window list the app icons seen so far.
    _rememberTrayIcons() {
        const known = this._settings.get_strv('tray-known');
        const byKey = new Map(known.map(entry => [entry.split('\t')[0], entry]));
        for (const child of this._adopted) {
            const key = trayKey(child);
            if (key)
                byKey.set(key, `${key}\t${trayLabel(child)}`);
        }
        const updated = [...byKey.values()].slice(-40);
        if (updated.join('\n') !== known.join('\n'))
            this._settings.set_strv('tray-known', updated);
    }

    openPrefs() {
        this._overflow.close();
        this._openPrefs?.();
    }

    _openBarMenu() {
        if (!this._barMenu) {
            this._menuAnchor = new St.Widget({width: 1, height: 1, opacity: 0});
            Main.layoutManager.uiGroup.add_child(this._menuAnchor);
            this._barMenu = new PopupMenu.PopupMenu(this._menuAnchor, 0.5, St.Side.BOTTOM);
            this._barMenu.actor.add_style_class_name('wtb-app-menu');
            Main.uiGroup.add_child(this._barMenu.actor);
            this._barMenu.actor.hide();
            this.menuManager.addMenu(this._barMenu);
            this._barMenu.addAction(_('Taskbar settings'), () => this.openPrefs());
        }
        const [x] = global.get_pointer();
        this._menuAnchor.set_position(x, this.top);
        this._barMenu.open();
    }

    _adoptDateMenu() {
        const dateMenu = Main.panel.statusArea?.dateMenu;
        const container = dateMenu?.container;
        if (!this._settings.get_boolean('show-clock'))
            return;
        this._clock = new Clock(this._settings, this._height);
        if (!container || !container.get_parent()) {
            this._addBeforeDesktopButton(this._clock.actor);
            return;
        }
        const parent = container.get_parent();
        this._dateMenuHome = {parent, index: parent.get_children().indexOf(container)};
        this._dateMenu = dateMenu;
        parent.remove_child(container);
        this._addBeforeDesktopButton(container);
        setArrowSide(dateMenu, St.Side.BOTTOM);

        // Show time over date, Windows style, inside GNOME's own clock
        // button, so clicking it still opens notifications and the calendar.
        const label = dateMenu._clockDisplay;
        if (label?.get_parent()) {
            label.hide();
            label.get_parent().insert_child_above(this._clock.actor, label);
            this._hiddenClockLabel = label;
        } else {
            this._rightBox.insert_child_below(this._clock.actor, container);
        }
        dateMenu.add_style_class_name('wtb-clock-button');
    }

    _addBeforeDesktopButton(actor) {
        if (this._desktopButton)
            this._rightBox.insert_child_below(actor, this._desktopButton);
        else
            this._rightBox.add_child(actor);
    }

    _restoreTopBar() {
        if (this._trayAddedId) {
            this._traySource.disconnect(this._trayAddedId);
            this._trayAddedId = 0;
        }
        this._overflow.close();
        if (this._traySource) {
            const ours = [...this._appTrayBox.get_children(), ...this._systemTrayBox.get_children(),
                ...this._overflow.children]
                .filter(c => this._adopted.includes(c));
            for (const child of ours) {
                child.get_parent()?.remove_child(child);
                this._traySource.add_child(child);
                setArrowSide(child.child, St.Side.TOP);
            }
        }
        this._traySource = null;
        this._adopted = [];

        this._clock?.destroy();
        this._clock = null;
        this._hiddenClockLabel?.show();
        this._hiddenClockLabel = null;
        if (this._dateMenu) {
            this._dateMenu.remove_style_class_name('wtb-clock-button');
            setArrowSide(this._dateMenu, St.Side.TOP);
            const container = this._dateMenu.container;
            container.get_parent()?.remove_child(container);
            const {parent, index} = this._dateMenuHome;
            parent.insert_child_at_index(container, Math.min(index, parent.get_n_children()));
            this._dateMenu = null;
        }
    }

    // ---- Keeping the app buttons in step with windows --------------------

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _connectSignals() {
        const appSys = Shell.AppSystem.get_default();
        const queue = () => this._queueSync();
        this._connect(appSys, 'app-state-changed', queue);
        this._connect(appSys, 'installed-changed', queue);
        this._connect(global.settings, 'changed::favorite-apps', queue);
        this._connect(global.display, 'notify::focus-window', queue);
        this._connect(global.display, 'window-demands-attention', queue);
        this._connect(global.display, 'window-marked-urgent', queue);
        this._connect(global.display, 'window-created', (_d, win) => {
            this._watchWindow(win);
            queue();
        });
        this._connect(global.workspace_manager, 'active-workspace-changed', queue);
        this._connect(Shell.WindowTracker.get_default(), 'tracked-windows-changed', queue);
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._place();
            queue();
        });
        this._connect(Main.overview, 'showing', () => this.hidePreviews());
        this._connect(Main.overview, 'item-drag-end', () => this._removePlaceholder());
        this._connect(Main.overview, 'item-drag-cancelled', () => this._removePlaceholder());
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);
    }

    _watchWindow(win) {
        if (!win || this._windowSignals.has(win))
            return;
        const ids = [
            win.connect('workspace-changed', () => this._queueSync()),
            win.connect('notify::skip-taskbar', () => this._queueSync()),
            win.connect('notify::title', () => this._previews.refresh()),
            win.connect('unmanaged', () => {
                this._unwatchWindow(win);
                this._queueSync();
            }),
        ];
        this._windowSignals.set(win, ids);
    }

    _unwatchWindow(win) {
        const ids = this._windowSignals.get(win);
        if (!ids)
            return;
        for (const id of ids) {
            try {
                win.disconnect(id);
            } catch {}
        }
        this._windowSignals.delete(win);
    }

    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    windowsFor(app) {
        const onlyHere = this._settings.get_boolean('current-workspace-only');
        const workspace = global.workspace_manager.get_active_workspace();
        return app.get_windows().filter(w => !w.skip_taskbar &&
            (!onlyHere || w.is_on_all_workspaces() || w.located_on_workspace(workspace)));
    }

    _sync() {
        // Leave the buttons where the user is dragging them.
        if (this._dragging || this._placeholder)
            return;
        const showPinned = this._settings.get_boolean('show-pinned-apps');
        const favorites = getFavorites().map(lookupApp).filter(Boolean)
            .filter(app => showPinned || this.windowsFor(app).length > 0);
        const favoriteIds = new Set(favorites.map(a => a.get_id()));

        const running = Shell.AppSystem.get_default().get_running()
            .filter(app => !favoriteIds.has(app.get_id()) && this.windowsFor(app).length > 0);
        const runningIds = new Set(running.map(a => a.get_id()));
        // New apps go on the end and stay put, like Windows.
        this._runningOrder = this._runningOrder.filter(id => runningIds.has(id));
        for (const app of running) {
            if (!this._runningOrder.includes(app.get_id()))
                this._runningOrder.push(app.get_id());
        }
        const byId = new Map(running.map(a => [a.get_id(), a]));
        // The order the user dragged them into; anything new goes at the end.
        const order = this._settings.get_strv('app-order');
        const rank = app => {
            const i = order.indexOf(app.get_id());
            return i < 0 ? Infinity : i;
        };
        // Pinned apps keep GNOME's favorites order; the rest follow, after
        // a divider, in the order they were opened or dragged into.
        const others = this._runningOrder.map(id => byId.get(id))
            .map((app, i) => ({app, i, r: rank(app)}))
            .sort((a, b) => (a.r - b.r) || (a.i - b.i))
            .map(x => x.app);
        const apps = [...favorites, ...others];

        const wanted = new Set(apps.map(a => a.get_id()));
        for (const [id, button] of this._buttons) {
            if (!wanted.has(id)) {
                button.destroy();
                this._buttons.delete(id);
            }
        }
        const actors = apps.map(app => {
            let button = this._buttons.get(app.get_id());
            if (!button || button.app !== app) {
                button?.destroy();
                button = new AppButton(this, app);
                this._buttons.set(app.get_id(), button);
                this._appsBox.add_child(button.actor);
            }
            button.update();
            return button.actor;
        });
        this._separator.visible = favorites.length > 0 && others.length > 0;
        actors.splice(favorites.length, 0, this._separator);
        actors.forEach((actor, index) => this._appsBox.set_child_at_index(actor, index));
        this._previews.refresh();
    }

    // ---- Drag and drop ----------------------------------------------------

    dragBegin(button) {
        this._dragging = button;
        this.hidePreviews();
        button.actor.opacity = 90;
    }

    dragEnd(button) {
        button.actor.opacity = 255;
        this._dragging = null;
        this._removePlaceholder();
        this._queueSync();
    }

    _dropIndex(moving) {
        const [px] = global.get_pointer();
        const others = this._appsBox.get_children().filter(c => c !== moving);
        for (let i = 0; i < others.length; i++) {
            const [cx] = others[i].get_transformed_position();
            const [cw] = others[i].get_transformed_size();
            if (px < cx + cw / 2)
                return i;
        }
        return others.length;
    }

    handleDragOver(source) {
        const app = source?.app;
        if (!app || typeof app.get_id !== 'function')
            return DND.DragMotionResult.CONTINUE;

        // One of our own buttons: move it live, so the others make room.
        if (this._dragging && source === this._dragging) {
            const actor = source.actor;
            const index = this._dropIndex(actor);
            if (this._appsBox.get_children().indexOf(actor) !== index)
                this._appsBox.set_child_at_index(actor, index);
            return DND.DragMotionResult.MOVE_DROP;
        }

        // An app from the app grid: show a gap where it would be pinned.
        if (!this._placeholder) {
            this._placeholder = new St.Widget({style_class: 'wtb-placeholder',
                width: this._buttonWidth, y_expand: true});
            this._placeholder.app = app;
            this._appsBox.add_child(this._placeholder);
            this._dragMonitor = {
                dragMotion: () => {
                    const [x, y] = global.get_pointer();
                    const [ax, ay] = this.actor.get_transformed_position();
                    const [aw, ah] = this.actor.get_transformed_size();
                    if (x < ax || x >= ax + aw || y < ay || y >= ay + ah)
                        this._removePlaceholder();
                    return DND.DragMotionResult.CONTINUE;
                },
            };
            DND.addDragMonitor(this._dragMonitor);
        }
        const index = this._dropIndex(this._placeholder);
        if (this._appsBox.get_children().indexOf(this._placeholder) !== index)
            this._appsBox.set_child_at_index(this._placeholder, index);
        return DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source) {
        const app = source?.app;
        if (!app || typeof app.get_id !== 'function')
            return false;
        const id = app.get_id();
        const external = !(this._dragging && source === this._dragging);

        const children = this._appsBox.get_children();
        const sepIndex = this._separator.visible ? children.indexOf(this._separator) : -1;
        const favorites = getFavorites();
        const order = [];
        const pinnedNow = [];
        children.forEach((c, i) => {
            let cid = null;
            if (c === this._placeholder) {
                cid = id;
            } else {
                for (const [bid, b] of this._buttons) {
                    if (b.actor === c)
                        cid = bid;
                }
            }
            if (!cid || order.includes(cid))
                return;
            order.push(cid);
            // Left of the divider is pinned, right of it is not. Without a
            // divider, only an app dropped in from the app grid gets pinned.
            let pinned;
            if (sepIndex >= 0)
                pinned = i < sepIndex;
            else
                pinned = cid === id ? external || favorites.includes(cid) : favorites.includes(cid);
            if (pinned)
                pinnedNow.push(cid);
        });

        const old = this._settings.get_strv('app-order').filter(x => !order.includes(x));
        this._settings.set_strv('app-order', [...order, ...old]);

        // Pinned apps not on the bar (hidden by a setting) keep their place.
        const hidden = favorites.filter(x => !order.includes(x));
        const updated = [...pinnedNow, ...hidden];
        if (updated.join() !== favorites.join())
            global.settings.set_strv('favorite-apps', updated);

        this._removePlaceholder();
        this._queueSync();
        return true;
    }

    _removePlaceholder() {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        if (this._placeholder) {
            this._placeholder.destroy();
            this._placeholder = null;
            this._queueSync();
        }
    }

    // ---- Previews ---------------------------------------------------------

    hoverChanged(button) {
        this._previews.hoverChanged(button);
    }

    hidePreviews() {
        this._previews.hide();
    }

    // ---- Show desktop -----------------------------------------------------

    _toggleDesktop() {
        const workspace = global.workspace_manager.get_active_workspace();
        const open = workspace.list_windows().filter(w => !w.minimized && !w.skip_taskbar &&
            w.get_window_type() === Meta.WindowType.NORMAL);
        if (open.length) {
            this._minimizedByUs = open;
            open.forEach(w => w.minimize());
            return;
        }
        const back = (this._minimizedByUs ?? []).filter(w => w.get_compositor_private());
        this._minimizedByUs = null;
        back.reverse().forEach(w => w.unminimize());
        if (back.length)
            Main.activateWindow(back[back.length - 1]);
    }

    destroy() {
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        for (const win of [...this._windowSignals.keys()])
            this._unwatchWindow(win);

        this._removePlaceholder();
        this._previews.destroy();
        for (const button of this._buttons.values())
            button.destroy();
        this._buttons.clear();
        this._restoreTopBar();
        this._overflow.destroy();
        this._barMenu?.destroy();
        this._menuAnchor?.destroy();
        this.accent.destroy();
        this._minimizedByUs = null;

        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
    }
}

// Lays out the three sections: left at the left edge, right at the right
// edge, and the middle one centred on the screen without overlapping them.
const TaskbarBox = GObject.registerClass({GTypeName: 'WinTaskbarBox'},
class TaskbarBox extends St.Widget {
    setBoxes(left, center, right) {
        this._left = left;
        this._center = center;
        this._right = right;
        for (const box of [left, center, right])
            this.add_child(box);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        if (!this._left)
            return;
        const content = this.get_theme_node().get_content_box(box);
        const x0 = content.x1;
        const y0 = content.y1;
        const width = content.x2 - content.x1;
        const height = content.y2 - content.y1;

        const natural = actor => Math.ceil(actor.get_preferred_width(height)[1]);
        const rightW = Math.min(natural(this._right), width);
        const leftW = Math.min(natural(this._left), width - rightW);
        const space = width - leftW - rightW;
        const centerW = Math.min(natural(this._center), Math.max(space, 0));

        let centerX = x0 + Math.floor((width - centerW) / 2);
        centerX = Math.min(centerX, x0 + width - rightW - centerW);
        centerX = Math.max(centerX, x0 + leftW);

        const place = (actor, x, w) => {
            const child = new Clutter.ActorBox();
            child.init_rect(x, y0, w, height);
            actor.allocate(child);
        };
        place(this._left, x0, leftW);
        place(this._center, centerX, centerW);
        place(this._right, x0 + width - rightW, rightW);
    }
});

// Top bar menus open downwards. GNOME flips them when they do not fit,
// but tell them up front that they now live at the bottom of the screen.
function setArrowSide(button, side) {
    const menu = button?.menu;
    if (!menu)
        return;
    try {
        const pointer = menu._boxPointer;
        if (pointer?.updateArrowSide)
            pointer.updateArrowSide(side);
        else if (pointer && '_userArrowSide' in pointer)
            pointer._userArrowSide = side;
        if ('_arrowSide' in menu)
            menu._arrowSide = side;
    } catch {}
}

// A stable name for an app's tray icon (the app's own id), or null for
// GNOME's own items, which always stay on the taskbar.
function trayKey(container) {
    const statusArea = Main.panel.statusArea ?? {};
    const role = Object.keys(statusArea).find(r => statusArea[r]?.container === container);
    if (!role || SYSTEM_ROLES.includes(role) || role === 'keyboard' || role === 'a11y')
        return null;
    const button = container.child;
    let id = null;
    try {
        id = button?._indicator?.id || button?._icon?.wm_class || null;
    } catch {}
    return id || role.replace(/^appindicator-/, '').replace(/:[\d.]+/g, '');
}

function trayLabel(container) {
    const button = container.child;
    let title = null;
    try {
        title = button?._indicator?.title || button?.accessible_name || null;
    } catch {}
    return title || trayKey(container) || '';
}

// The ^ button and the little panel above it that holds the hidden tray
// icons, like the Windows notification area overflow.
class TrayOverflow {
    constructor(taskbar) {
        this._taskbar = taskbar;
        this.chevron = new St.Button({style_class: 'wtb-button wtb-chevron', can_focus: true,
            y_expand: true, accessible_name: _('Show hidden icons'), visible: false,
            child: new St.Icon({icon_name: 'pan-up-symbolic', icon_size: 16})});
        this.chevron.connect('clicked', () => this.toggle());

        this.actor = vbox({style_class: 'wtb-overflow', reactive: true, visible: false});
        this._grid = vbox({style_class: 'wtb-overflow-grid'});
        this.actor.add_child(this._grid);
        const settings = new St.Button({style_class: 'wtb-overflow-settings', can_focus: true,
            label: _('Choose which icons show on the taskbar…'), x_align: Clutter.ActorAlign.FILL});
        settings.connect('clicked', () => taskbar.openPrefs());
        this.actor.add_child(settings);
        this._items = [];
        this._menuIds = new Map();
        this._destroyIds = new Map();

        // Clicks outside close it. Inside, the icons behave as usual
        // (click for the menu, double-click to open the app).
        this.actor.connect('button-press-event', (_a, event) => {
            const [x, y] = event.get_coords();
            const [ax, ay] = this.actor.get_transformed_position();
            const [aw, ah] = this.actor.get_transformed_size();
            if (x < ax || x >= ax + aw || y < ay || y >= ay + ah) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        Main.layoutManager.addTopChrome(this.actor);
    }

    get children() {
        return [...this._items];
    }

    add(container, index) {
        this._items.splice(index < 0 ? this._items.length : index, 0, container);
        const menu = container.child?.menu;
        if (menu) {
            // When an icon's own menu closes, close this panel too.
            const id = menu.connect('open-state-changed', (_m, open) => {
                if (!open && this.actor.visible)
                    this.close();
            });
            this._menuIds.set(container, [menu, id]);
        }
        this._destroyIds.set(container, container.connect('destroy', () => this._forget(container)));
        this._layout();
    }

    _forget(container) {
        this._items = this._items.filter(c => c !== container);
        this._destroyIds.delete(container);
        const entry = this._menuIds.get(container);
        if (entry) {
            try {
                entry[0].disconnect(entry[1]);
            } catch {}
            this._menuIds.delete(container);
        }
        this._layout();
    }

    _layout() {
        for (const row of this._grid.get_children()) {
            for (const child of row.get_children())
                row.remove_child(child);
            row.destroy();
        }
        let row = null;
        this._items.forEach((container, i) => {
            if (i % 5 === 0) {
                row = new St.BoxLayout({style_class: 'wtb-overflow-row'});
                this._grid.add_child(row);
            }
            container.get_parent()?.remove_child(container);
            row.add_child(container);
        });
        this.chevron.visible = this._items.length > 0;
        if (!this._items.length)
            this.close();
    }

    toggle() {
        if (this.actor.visible)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.actor.visible || !this._items.length)
            return;
        this._taskbar.hidePreviews();
        this.actor.show();
        const [, natW] = this.actor.get_preferred_width(-1);
        const [, natH] = this.actor.get_preferred_height(natW);
        const [cx] = this.chevron.get_transformed_position();
        const [cw] = this.chevron.get_transformed_size();
        const monitor = Main.layoutManager.primaryMonitor;
        let x = cx + cw / 2 - natW / 2;
        x = Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - natW - 8));
        this.actor.set_position(Math.round(x), Math.round(this._taskbar.top - natH - 8));
        this.chevron.add_style_pseudo_class('checked');
        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        this.actor.grab_key_focus();
    }

    close() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        // Close any icon menu still open from inside before hiding.
        for (const container of this._items)
            container.child?.menu?.isOpen && container.child.menu.close();
        this.actor.hide();
        this.chevron.remove_style_pseudo_class('checked');
    }

    destroy() {
        this.close();
        for (const [menu, id] of this._menuIds.values()) {
            try {
                menu.disconnect(id);
            } catch {}
        }
        this._menuIds.clear();
        for (const [container, id] of this._destroyIds) {
            try {
                container.disconnect(id);
            } catch {}
        }
        this._destroyIds.clear();
        // Restored containers were taken out already; drop the rest of our UI.
        for (const row of this._grid.get_children()) {
            for (const child of row.get_children())
                row.remove_child(child);
        }
        this._items = [];
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.chevron.destroy();
    }
}

// One button per app. Windows of the same app are grouped on it.
class AppButton {
    constructor(taskbar, app) {
        this._taskbar = taskbar;
        this.app = app;
        const size = taskbar.buttonWidth;

        const layout = new St.Widget({layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true});
        this._icon = new St.Bin({child: app.create_icon_texture(taskbar.iconSize),
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        // One dot per window (up to four), like the Ubuntu Dock.
        // BinLayout only honours alignment on children that expand.
        this._indicator = new St.BoxLayout({style_class: 'wtb-dots', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END});
        layout.add_child(this._icon);
        layout.add_child(this._indicator);

        this.actor = new St.Button({style_class: 'wtb-button wtb-app', child: layout,
            can_focus: true, track_hover: true, y_expand: true, width: size,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            accessible_name: app.get_name()});
        this.actor.connect('clicked', (_b, clicked) => this._onClicked(clicked));
        this.actor.connect('notify::hover', () => taskbar.hoverChanged(this));
        this.actor.connect('scroll-event', (_b, event) => this._onScroll(event));

        this.actor._delegate = this;
        this._draggable = DND.makeDraggable(this.actor);
        this._draggable.connect('drag-begin', () => taskbar.dragBegin(this));
        this._draggable.connect('drag-cancelled', () => taskbar.dragEnd(this));
        this._draggable.connect('drag-end', () => taskbar.dragEnd(this));
    }

    // ---- What DND asks of a drag source and drop target ----

    getDragActor() {
        return this.app.create_icon_texture(this._taskbar.iconSize);
    }

    getDragActorSource() {
        return this._icon;
    }

    handleDragOver(source) {
        return this._taskbar.handleDragOver(source);
    }

    acceptDrop(source) {
        return this._taskbar.acceptDrop(source);
    }

    get windows() {
        return this._taskbar.windowsFor(this.app);
    }

    update() {
        const windows = this.windows;
        const focus = global.display.focus_window;
        const focused = windows.some(w => w === focus);
        const urgent = !focused && windows.some(w => w.demands_attention || w.urgent);
        this._setClass('running', windows.length > 0);
        this._setClass('focused', focused);
        this._setClass('urgent', urgent);
        this._setClass('many', windows.length > 1);

        // Dots under the icon in the system accent color.
        const color = urgent ? '#ffa040' : this._taskbar.accent.css(1);
        const count = Math.min(windows.length, 4);
        const key = `${count}/${color}`;
        if (this._dotsKey !== key) {
            this._dotsKey = key;
            this._indicator.destroy_all_children();
            for (let i = 0; i < count; i++) {
                this._indicator.add_child(new St.Widget({width: 5, height: 5,
                    style: `background-color: ${color}; border-radius: 3px;`}));
            }
        }
    }

    _setClass(name, on) {
        if (on)
            this.actor.add_style_class_name(name);
        else
            this.actor.remove_style_class_name(name);
    }

    _onClicked(clicked) {
        this._taskbar.hidePreviews();
        const shift = global.get_pointer()[2] & Clutter.ModifierType.SHIFT_MASK;
        if (clicked === Clutter.BUTTON_SECONDARY) {
            this._openMenu();
        } else if (clicked === Clutter.BUTTON_MIDDLE || shift) {
            this._newWindow();
        } else {
            this._activate();
        }
    }

    _newWindow() {
        if (this.app.can_open_new_window())
            this.app.open_new_window(-1);
        else
            this.app.activate();
    }

    _activate() {
        const windows = this.windows;
        if (!windows.length) {
            this.app.activate();
            return;
        }
        const focus = global.display.focus_window;
        if (windows.length === 1) {
            const [win] = windows;
            if (win === focus && !win.minimized)
                win.minimize();
            else
                Main.activateWindow(win);
            return;
        }
        // Several windows: bring the app forward, then cycle through them.
        if (!windows.includes(focus)) {
            Main.activateWindow(windows[0]);
            return;
        }
        const ordered = [...windows].sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        const next = ordered[(ordered.indexOf(focus) + 1) % ordered.length];
        Main.activateWindow(next);
    }

    _onScroll(event) {
        const windows = this.windows;
        if (windows.length < 2)
            return Clutter.EVENT_PROPAGATE;
        const direction = event.get_scroll_direction();
        let step = 0;
        if (direction === Clutter.ScrollDirection.UP)
            step = -1;
        else if (direction === Clutter.ScrollDirection.DOWN)
            step = 1;
        if (!step)
            return Clutter.EVENT_PROPAGATE;
        const ordered = [...windows].sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        const current = Math.max(0, ordered.indexOf(global.display.focus_window));
        Main.activateWindow(ordered[(current + step + ordered.length) % ordered.length]);
        return Clutter.EVENT_STOP;
    }

    _openMenu() {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this.actor, 0.5, St.Side.BOTTOM);
            this._menu.actor.add_style_class_name('wtb-app-menu');
            Main.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this._taskbar.menuManager.addMenu(this._menu);
            this._menu.connect('open-state-changed', (_m, open) => {
                if (open)
                    this.actor.add_style_pseudo_class('active');
                else
                    this.actor.remove_style_pseudo_class('active');
            });
        }
        this._menu.removeAll();

        // The app's own shortcuts ("New private window" and so on).
        const info = this.app.get_app_info();
        const actions = info?.list_actions?.() ?? [];
        for (const action of actions) {
            this._menu.addAction(info.get_action_name(action),
                () => this.app.launch_action(action, global.get_current_time(), -1));
        }
        if (actions.length)
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._menu.addAction(this.app.get_name(), () => this._newWindow());
        const id = this.app.get_id();
        if (id && !id.startsWith('window:')) {
            const pinned = isFavorite(id);
            this._menu.addAction(pinned ? _('Unpin from taskbar') : _('Pin to taskbar'),
                () => setFavorite(id, !pinned));
        }
        const windows = this.windows;
        if (windows.length) {
            this._menu.addAction(windows.length > 1 ? _('Close all windows') : _('Close window'),
                () => windows.forEach(w => w.delete(global.get_current_time())));
        }
        this._menu.open();
    }

    destroy() {
        this.destroyed = true;
        this._menu?.destroy();
        this._menu = null;
        this.actor.destroy();
    }
}

// Thumbnails of an app's windows, shown when hovering its button.
class PreviewPopup {
    constructor(taskbar) {
        this._taskbar = taskbar;
        this._button = null;
        this._showId = 0;
        this._hideId = 0;
        this.actor = new St.BoxLayout({style_class: 'wtb-previews', reactive: true,
            track_hover: true, visible: false});
        this.actor.connect('notify::hover', () => this._scheduleHide());
        Main.layoutManager.addTopChrome(this.actor);
    }

    hoverChanged(button) {
        if (button.destroyed)
            return;
        if (button.actor.hover) {
            this._clearTimer('_hideId');
            if (this.actor.visible) {
                // Already showing: switch straight away, like Windows.
                this._show(button);
                return;
            }
            this._clearTimer('_showId');
            this._showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_SHOW_MS, () => {
                this._showId = 0;
                if (!button.destroyed && button.actor.hover && !this._taskbar.menuManager.activeMenu)
                    this._show(button);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._clearTimer('_showId');
            this._scheduleHide();
        }
    }

    _scheduleHide() {
        this._clearTimer('_hideId');
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_HIDE_MS, () => {
            this._hideId = 0;
            if (!this.actor.hover && (!this._button || this._button.destroyed || !this._button.actor.hover))
                this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer(name) {
        if (this[name]) {
            GLib.source_remove(this[name]);
            this[name] = 0;
        }
    }

    refresh() {
        if (!this.actor.visible || !this._button)
            return;
        if (this._button.destroyed) {
            this.hide();
            return;
        }
        this._show(this._button);
    }

    _show(button) {
        this._button = button;
        this.actor.destroy_all_children();
        const windows = button.windows.slice(0, MAX_PREVIEWS);

        if (!windows.length) {
            // Not running: just a name tooltip.
            this.actor.add_style_class_name('tooltip');
            this.actor.add_child(new St.Label({text: button.app.get_name(), style_class: 'wtb-tooltip'}));
        } else {
            this.actor.remove_style_class_name('tooltip');
            const sorted = [...windows].sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
            for (const win of sorted)
                this.actor.add_child(this._card(button, win));
        }
        this.actor.show();
        this._position(button);
    }

    _card(button, win) {
        const card = vbox({style_class: 'wtb-preview'});
        if (win === global.display.focus_window)
            card.add_style_pseudo_class('checked');

        const header = new St.BoxLayout({style_class: 'wtb-preview-header'});
        const titleBox = new St.BoxLayout({style_class: 'wtb-preview-title-box'});
        titleBox.add_child(button.app.create_icon_texture(16));
        const title = new St.Label({text: win.get_title() ?? button.app.get_name(),
            style_class: 'wtb-preview-title', y_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleBox.add_child(title);
        const titleButton = new St.Button({child: titleBox, x_expand: true,
            style_class: 'wtb-preview-title-button', x_align: Clutter.ActorAlign.FILL});
        titleButton.connect('clicked', () => this._activate(win));
        header.add_child(titleButton);

        const close = new St.Button({style_class: 'wtb-preview-close', accessible_name: _('Close'),
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14})});
        close.connect('clicked', () => win.delete(global.get_current_time()));
        header.add_child(close);
        card.add_child(header);

        const thumb = new St.Bin({style_class: 'wtb-preview-thumb', width: PREVIEW_W, height: PREVIEW_H,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const source = win.get_compositor_private();
        if (source) {
            const [w, h] = source.get_size();
            const scale = Math.min(PREVIEW_W / Math.max(w, 1), PREVIEW_H / Math.max(h, 1), 1);
            thumb.child = new Clutter.Clone({source, width: Math.round(w * scale),
                height: Math.round(h * scale), x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER});
        }
        const thumbButton = new St.Button({child: thumb, style_class: 'wtb-preview-thumb-button',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO});
        thumbButton.connect('clicked', (_b, clicked) => {
            if (clicked === Clutter.BUTTON_MIDDLE)
                win.delete(global.get_current_time());
            else
                this._activate(win);
        });
        card.add_child(thumbButton);
        return card;
    }

    _activate(win) {
        this.hide();
        Main.activateWindow(win);
    }

    _position(button) {
        const monitor = Main.layoutManager.primaryMonitor;
        const [bx] = button.actor.get_transformed_position();
        const [bw] = button.actor.get_transformed_size();
        const [, natW] = this.actor.get_preferred_width(-1);
        const [, natH] = this.actor.get_preferred_height(natW);
        let x = bx + bw / 2 - natW / 2;
        x = Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - natW - 8));
        const y = this._taskbar.top - natH - 8;
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    hide() {
        this._clearTimer('_showId');
        this._clearTimer('_hideId');
        this._button = null;
        this.actor.hide();
        this.actor.destroy_all_children();
    }

    destroy() {
        this.hide();
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}

// Time over date. The formats come from the settings; an empty time
// format follows GNOME's 12 or 24 hour choice.
class Clock {
    constructor(settings, height) {
        this._settings = settings;
        this.actor = vbox({style_class: 'wtb-clock', y_align: Clutter.ActorAlign.CENTER});
        const align = Clutter.ActorAlign.CENTER;
        this._time = new St.Label({style_class: 'wtb-clock-time', x_align: align});
        this._date = new St.Label({style_class: 'wtb-clock-date', x_align: align});
        this.actor.add_child(this._time);
        if (settings.get_boolean('show-date'))
            this.actor.add_child(this._date);
        let style = `max-height: ${Math.max(height - 8, 20)}px;`;
        const size = settings.get_double('clock-font-size');
        if (size > 0)
            style += ` font-size: ${size}pt;`;
        this.actor.style = style;

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._formatId = this._interface.connect('changed::clock-format', () => this._update());
        this._update();
    }

    _timeFormat() {
        const custom = this._settings.get_string('time-format');
        if (custom)
            return custom;
        return this._interface.get_string('clock-format') === '12h' ? '%-I:%M %p' : '%H:%M';
    }

    _update() {
        const now = GLib.DateTime.new_now_local();
        const timeFormat = this._timeFormat();
        const dateFormat = this._settings.get_string('date-format') || '%x';
        this._time.text = now.format(timeFormat) ?? '';
        this._date.text = now.format(dateFormat) ?? '';

        // Tick every second only when seconds are shown.
        const seconds = /%[-_0^#]?[STrX]/.test(timeFormat + dateFormat);
        const wait = seconds ? 1 : 61 - now.get_second();
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
            this._timerId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        this._interface.disconnect(this._formatId);
        this._interface = null;
        this.actor.destroy();
    }
}
