#!/usr/bin/env python3
"""YouTube sign-in for the harvester's yt-dlp requests.

YouTube refuses anonymous downloads from a busy address with "Sign in to confirm you're not a bot. Use --cookies".
yt-dlp then needs the cookies of a signed-in YouTube session. The owner signs in to YouTube in a browser on this
Mac; WORK/youtube-auth.json names that browser (and profile), or a Netscape cookies.txt file, and yt-dlp reads the
cookies itself at request time. Nothing here copies, stores or sends cookie values, and passwords are never handled.

    {"mode": "browser", "browser": "chrome", "profile": "/Users/…/Chrome/Profile 1", "savedAt": "…"}
    {"mode": "file", "cookieFile": "/Users/…/youtube-cookies.txt", "savedAt": "…"}
    {"mode": "none"}

The running harvester re-reads the file when it changes (harvest.py Harvester.auth), so a sign-in added from the
Validate tab ends the current bot-check pause without a restart.

    python3 -I youtube_auth.py test --config '{"mode":"browser","browser":"firefox"}' [--video ID]
"""
import argparse
import configparser
import datetime as dt
import json
import os
from pathlib import Path
import re

AUTH_FILE = 'youtube-auth.json'
HOME = Path.home()
SUPPORT = HOME / 'Library/Application Support'
# yt-dlp's names; the folder whose existence shows the browser is installed with a profile store (macOS).
BROWSERS = {
    'chrome': ('Google Chrome', SUPPORT / 'Google/Chrome'),
    'firefox': ('Firefox', SUPPORT / 'Firefox'),
    'safari': ('Safari', HOME / 'Library/Containers/com.apple.Safari/Data/Library/Cookies'),
    'brave': ('Brave', SUPPORT / 'BraveSoftware/Brave-Browser'),
    'edge': ('Microsoft Edge', SUPPORT / 'Microsoft Edge'),
    'chromium': ('Chromium', SUPPORT / 'Chromium'),
    'opera': ('Opera', SUPPORT / 'com.operasoftware.Opera'),
    'vivaldi': ('Vivaldi', SUPPORT / 'Vivaldi'),
}
CHROMIUM = {'chrome', 'brave', 'edge', 'chromium', 'opera', 'vivaldi'}
# YouTube's bot check (needs a signed-in session) is told apart from a plain rate limit (429).
BOT_CHECK_RE = re.compile(r"not a bot|sign in to confirm(?! your age)|use --cookies", re.I)
COOKIE_ERROR_RE = re.compile(r"cookie|keyring|keychain|decrypt|could not copy|operation not permitted|full disk access", re.I)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def block_kind(message):
    """'bot-check' when YouTube wants a signed-in session, else 'rate-limit'."""
    return 'bot-check' if BOT_CHECK_RE.search(str(message or '')) else 'rate-limit'


def is_cookie_error(message):
    message = str(message or '')
    return bool(COOKIE_ERROR_RE.search(message)) and not BOT_CHECK_RE.search(message)


def normalize(value):
    """A validated config, or ValueError. Paths must exist; browsers must be known."""
    value = value if isinstance(value, dict) else {}
    mode = value.get('mode') or 'none'
    if mode == 'none':
        return {'mode': 'none'}
    if mode == 'browser':
        browser = value.get('browser')
        if browser not in BROWSERS:
            raise ValueError('Choose one of: ' + ', '.join(BROWSERS) + '.')
        profile = value.get('profile') or None
        if profile is not None:
            if not isinstance(profile, str) or len(profile) > 500 or not Path(profile).expanduser().is_dir():
                raise ValueError('The browser profile folder does not exist.')
            profile = str(Path(profile).expanduser())
        return {'mode': 'browser', 'browser': browser, 'profile': profile}
    if mode == 'file':
        path = value.get('cookieFile')
        if not isinstance(path, str) or len(path) > 500 or not Path(path).expanduser().is_file():
            raise ValueError('The cookies file does not exist.')
        return {'mode': 'file', 'cookieFile': str(Path(path).expanduser())}
    raise ValueError('mode must be none, browser or file.')


def load(work_dir):
    try:
        raw = json.loads((Path(work_dir) / AUTH_FILE).read_text(encoding='utf-8'))
        return {**normalize(raw), 'savedAt': raw.get('savedAt')}
    except (OSError, ValueError):
        return {'mode': 'none'}


def stamp(work_dir):
    try:
        return (Path(work_dir) / AUTH_FILE).stat().st_mtime_ns
    except OSError:
        return None


def save(work_dir, value):
    config = {**normalize(value), 'savedAt': now_iso()}
    path = Path(work_dir) / AUTH_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.%s.tmp' % os.getpid())
    tmp.write_text(json.dumps(config, indent=1), encoding='utf-8')
    os.replace(tmp, path)
    return config


def ydl_options(config):
    """yt-dlp options for a config (empty for none)."""
    if config.get('mode') == 'browser':
        return {'cookiesfrombrowser': (config['browser'], config.get('profile'), None, None)}
    if config.get('mode') == 'file':
        return {'cookiefile': config['cookieFile']}
    return {}


def label(config, browsers=None):
    if config.get('mode') == 'browser':
        name = BROWSERS[config['browser']][0]
        profile = config.get('profile')
        if profile:
            known = next((p['label'] for b in (browsers or []) if b['id'] == config['browser'] for p in b['profiles'] if p['path'] == profile), None)
            name += ' · ' + (known or Path(profile).name)
        return 'Signed in through ' + name
    if config.get('mode') == 'file':
        return 'Cookies file ' + Path(config['cookieFile']).name
    return 'Not signed in'


def _chromium_profiles(root):
    names = {}
    try:
        cache = json.loads((root / 'Local State').read_text(encoding='utf-8')).get('profile', {}).get('info_cache', {})
        names = {k: (v.get('name') or k) + (' (' + v['user_name'] + ')' if v.get('user_name') else '') for k, v in cache.items()}
    except (OSError, ValueError, AttributeError):
        pass
    out = []
    for path in sorted(root.glob('*')):
        if path.is_dir() and (path.name == 'Default' or path.name.startswith('Profile ')) and \
                ((path / 'Cookies').exists() or (path / 'Network/Cookies').exists()):
            out.append({'path': str(path), 'label': names.get(path.name, path.name)})
    return out


def _firefox_profiles(root):
    parser = configparser.ConfigParser()
    try:
        parser.read(root / 'profiles.ini', encoding='utf-8')
    except configparser.Error:
        return []
    out = []
    for section in parser.sections():
        if not section.startswith('Profile') or 'Path' not in parser[section]:
            continue
        p = parser[section]
        path = (root / p['Path']) if p.get('IsRelative', '1') == '1' else Path(p['Path'])
        if (path / 'cookies.sqlite').exists():
            out.append({'path': str(path), 'label': p.get('Name', path.name) + (' (default)' if p.get('Default') == '1' else '')})
    return out


def browsers():
    """Installed browsers with their profiles (most recently used first). Safari's store needs Full Disk Access."""
    out = []
    for key, (name, root) in BROWSERS.items():
        if key == 'safari':
            installed = Path('/Applications/Safari.app').exists()
            profiles = []
        else:
            installed = root.is_dir()
            profiles = _firefox_profiles(root) if key == 'firefox' and installed else _chromium_profiles(root) if installed else []
            profiles.sort(key=lambda p: -max((Path(p['path']) / f).stat().st_mtime if (Path(p['path']) / f).exists() else 0
                                             for f in ('cookies.sqlite', 'Cookies', 'Network/Cookies')))
        if installed:
            out.append({'id': key, 'label': name, 'profiles': profiles,
                        'note': 'Reading Safari cookies needs Full Disk Access for Python (System Settings › Privacy & Security).' if key == 'safari'
                        else 'macOS asks once for access to “' + name + ' Safe Storage”; choose Always Allow.' if key in CHROMIUM else ''})
    return out


def test(config, video='jNQXAC9IVRw'):
    """Resolve one video's formats with the config, as a download would (nothing is downloaded)."""
    import yt_dlp
    class Quiet:  # errors come back as the exception; nothing on stderr
        def debug(self, msg): pass
        info = warning = error = debug
    options = {'quiet': True, 'no_warnings': True, 'skip_download': True, 'noplaylist': True, 'socket_timeout': 30,
               'extractor_retries': 1, 'logger': Quiet(), **ydl_options(config)}
    try:
        with yt_dlp.YoutubeDL(options) as y:
            info = y.extract_info('https://www.youtube.com/watch?v=' + video, download=False)
            cookies = sum(1 for c in y.cookiejar if c.domain.endswith('youtube.com') or c.domain.endswith('google.com'))
        formats = [f for f in info.get('formats') or [] if f.get('vcodec') not in (None, 'none')]
        if not formats:
            return {'ok': False, 'kind': 'no-formats', 'message': 'YouTube answered but offered no video formats.', 'cookies': cookies}
        signed = cookies > 0 or config.get('mode') == 'none'
        return {'ok': True, 'kind': 'ok', 'video': video, 'title': info.get('title'), 'formats': len(formats), 'cookies': cookies,
                'message': ('Downloads work' + (' with %d YouTube/Google cookies.' % cookies if cookies else '.')) if signed else
                'Downloads work, but no YouTube cookies were found in that browser: sign in to YouTube there first.'}
    except Exception as ex:  # yt_dlp.utils.DownloadError, cookie database and keychain errors
        message = re.sub(r'\x1b\[[0-9;]*m', '', str(ex))[:400]
        kind = 'cookies' if is_cookie_error(message) else block_kind(message) if re.search(r'429|too many|bot|sign in to confirm', message, re.I) else 'error'
        return {'ok': False, 'kind': kind, 'message': message}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['test', 'browsers'])
    ap.add_argument('--config', default='{}')
    ap.add_argument('--video', default='jNQXAC9IVRw')
    args = ap.parse_args()
    if args.command == 'browsers':
        print(json.dumps(browsers()))
    else:
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', args.video):
            raise SystemExit('invalid video id')
        print(json.dumps(test(normalize(json.loads(args.config)), args.video)))
