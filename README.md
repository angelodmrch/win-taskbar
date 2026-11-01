# Win Taskbar for Ubuntu

A taskbar that works like the one in modern Windows, built as a GNOME Shell
extension so it works on Ubuntu's default Wayland session as well as X11.
It is separate from the Win+V Clipboard extension; you can use either or both.

## Features

- **Bottom taskbar** across the main screen, with icons in the middle like
  Windows 11 (or on the left like Windows 10, in Settings).
- **Ubuntu button** at the start of the bar opens Ubuntu's own app grid (the
  same as Show Applications on the dock). Super still works as usual.
- **App buttons** for pinned and running apps. Windows of the same app are
  grouped on one button.
  - Click to open, switch to, or minimize the app. With several windows, each
    click goes to the next one. Scrolling on the button does the same.
  - Middle-click or Shift+click opens a new window.
  - Hover to see **live previews** of each window, with a close button.
  - **Drag** buttons to put them in any order. Dropping an app left of the
    divider pins it; right of it unpins it. Drag an app from the app grid
    onto the taskbar to pin it there.
  - Right-click for the app's own actions (like "New private window"),
    pin or unpin, and close.
  - Looks like the Ubuntu Dock: a dot per open window under each icon in
    your system accent color, a rounded highlight on the app in front, and a
    divider between pinned and unpinned apps. Apps that want your attention
    turn orange.
- **Task View** button opens GNOME's overview of all windows and workspaces.
- **System tray**: network, sound, battery and the quick settings menu, plus
  any app tray icons, all moved down from the top bar. Like Windows, app icons
  are hidden behind a **^** button unless you choose to always show them
  (Settings > Icons). Double-click an app's tray icon to open the app.
- Right-click an empty part of the taskbar for **Taskbar settings**.
- **Clock** with time over date. Click it for the calendar and notifications.
- **Show desktop** strip at the far right: click to minimize everything, click
  again to bring it back.
- Hides itself under full-screen apps and videos.

The top bar and the Ubuntu Dock are turned off while the taskbar runs (you
can keep either in Settings). Disabling the taskbar brings them back.

Supports GNOME Shell 45 to 50 (Ubuntu 23.10 and newer).

## Install

### From the .deb (recommended)

```bash
sudo apt install ./gnome-shell-extension-win-taskbar_<version>_all.deb
```

The package turns the extension on for everyone who is logged in and shows a
notification with a **Log out now** button. GNOME only loads the new code after
you log out and back in, so do that when the notification appears (on an update
too). If you are not logged in to GNOME while installing, enable it later with
`gnome-extensions enable win-taskbar@angelo`.

### From source (current user only)

```bash
bash install.sh
```

Then log out and back in and run the same `gnome-extensions enable` command.

> A copy in `~/.local/share/gnome-shell/extensions/` wins over the system one
> from the .deb. Remove it if you switch to the .deb.

## Settings

`gnome-extensions prefs win-taskbar@angelo` (or the Extensions app). Changes
apply straight away.

- **Taskbar**: bar height, icon size, background opacity, icons centered or on the left, only
  current workspace, hide the top bar, turn off the Ubuntu Dock, blur.
- **Icons**: show or hide the Ubuntu button, Task View, pinned apps, Show
  desktop, the whole system tray, and in the tray the keyboard layout,
  accessibility and app icons (items you turn off stay in the top bar), and
  which app tray icons are always shown instead of behind the ^ button, and
  the space between tray icons. Shown app icons sit left of the ^ button,
  GNOME's system icons to its right.
- **Clock**: show or hide it, time format (system, 24-hour, 12-hour, with
  seconds, or your own), show the date and its format (region default, several
  presets, or your own), and the text size. Custom formats use strftime codes
  such as `%H:%M` or `%d/%m/%Y`.

Apps pinned to the taskbar are GNOME's favorites, so they match the dash in
the overview.

## If something goes wrong

- Turn it off: `gnome-extensions disable win-taskbar@angelo`. The top bar and
  dock come back.
- If you removed the package while the taskbar was on and the dock is still
  gone: `gnome-extensions enable ubuntu-dock@ubuntu.com`.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i win-taskbar`

## Limits

- The taskbar is on the main screen only.
- Notifications still pop up at the top of the screen.

## Development

Test without logging out by running a nested GNOME session in a window:

```bash
sudo apt install mutter-dev-bin
dbus-run-session gnome-shell --devkit --wayland
```

Build the packages (output goes to `dist/`):

```bash
bash packaging/build-deb.sh   # needs dpkg-deb
bash packaging/pack-zip.sh    # zip for `gnome-extensions install`
```

Bump `"version"` in `metadata.json` before building a new release; the .deb
version comes from it.

### Files

- `extension.js`: turns the taskbar on and off, hides the top bar and dock.
- `taskbar.js`: the bar, app buttons, window previews, tray and clock.
- `utils.js`: small shared helpers.
