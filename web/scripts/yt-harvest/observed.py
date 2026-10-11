"""Read-only, cached observed battle catalog with explicit detection/date provenance."""
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import threading


def read(path, default):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def date(value):
    text = str(value or '').replace('-', '')[:8]
    try:
        return dt.datetime.strptime(text, '%Y%m%d').date().isoformat()
    except ValueError:
        return None


def stamp(path):
    try:
        s = path.stat()
        return (str(path), s.st_mtime_ns, s.st_size)
    except OSError:
        return (str(path), None, None)


def human(answer):
    return (isinstance(answer, dict) and answer.get('value') is not None
            and answer.get('source') != 'model' and not answer.get('modelResolved'))


class ObservedCatalog:
    MAX_FILES = 5000
    MAX_OCCURRENCES = 10000

    def __init__(self, work_dir, web_root):
        self.work = Path(work_dir)
        self.web = Path(web_root)
        self.registry = self.web / 'tests/meta-benchmark/sources/registry.json'
        self.schedule = self.web / 'scripts/yt-harvest/data/gbl-schedule.json'
        self.lock = threading.RLock()
        self._signature = None
        self._value = None

    def state(self):
        with self.lock:
            result_files = sorted(p for p in (self.work / 'results').glob('*.json')
                                  if not p.name.endswith(('.leagues.json', '.learned.json')) and p.name != 'batch-summary.json')
            files = result_files[:self.MAX_FILES]
            feedback = read(self.work / 'feedback.json', {})
            version = (feedback.get('learning') or {}).get('version', 0)
            refits = self.work / 'learning' / ('refit-' + str(version))
            watched = [self.registry, self.schedule, self.work / 'feedback.json']
            for p in files:
                watched.extend([p, p.with_name(p.stem + '.leagues.json'), self.work / 'labels' / p.name,
                                refits / p.name])
            sig = tuple(stamp(p) for p in watched)
            if self._signature == sig and self._value is not None:
                return self._value
            registry = read(self.registry, [])
            videos = registry if isinstance(registry, list) else registry.get('videos', [])
            by_id = {v.get('id'): v for v in videos if isinstance(v, dict)}
            schedule = read(self.schedule, {})
            occurrences, errors, videos_with_battles = [], [], set()
            excluded = {'rocket': 0}
            for p in files:
                raw = read(p, None)
                if not isinstance(raw, dict):
                    errors.append({'videoId': p.stem, 'error': 'Result file is unavailable or incomplete'})
                    continue
                fitted = refits / p.name
                # A completed refit must not supersede a subsequently re-extracted video.
                if fitted.exists() and fitted.stat().st_mtime_ns >= p.stat().st_mtime_ns:
                    updated = read(fitted, {})
                    if isinstance(updated, dict) and isinstance(updated.get('full'), list):
                        raw = updated
                full = raw.get('full') or raw.get('battles') or []
                if not isinstance(full, list):
                    continue
                labels = read(self.work / 'labels' / p.name, {})
                leagues = read(p.with_name(p.stem + '.leagues.json'), {})
                video = {**by_id.get(p.stem, {}), **(raw.get('video') or {})}
                for a in feedback.get('answers', {}).values():
                    if self._video(a) == p.stem and isinstance(a.get('video'), dict):
                        video = {**a['video'], **video}
                for i, b in enumerate(full):
                    if not isinstance(b, dict):
                        continue
                    row = self._occurrence(p.stem, i, b, raw, video, labels, leagues, feedback, schedule)
                    if row['battleType'] == 'rocket':
                        excluded['rocket'] += 1   # Team Rocket battles train the extractor but are never meta
                        continue
                    occurrences.append(row)
                    videos_with_battles.add(p.stem)
                    if len(occurrences) >= self.MAX_OCCURRENCES:
                        break
                if len(occurrences) >= self.MAX_OCCURRENCES:
                    break
            occurrences.sort(key=lambda o: (o['source'].get('uploadDate') or '', o['source']['videoId'], o['battle']['start']), reverse=True)
            revision = hashlib.sha256(repr(sig).encode()).hexdigest()[:20]
            value = {'revision': revision, 'occurrences': occurrences, 'summary': {
                'videos': len(videos_with_battles), 'battles': len(occurrences),
                'completeCreatorTeams': sum(o['complete']['my'] for o in occurrences),
                'completeOpponentTeams': sum(o['complete']['opponent'] for o in occurrences),
                'incompleteBattles': sum(not all(o['complete'].values()) for o in occurrences),
                'championshipBattles': sum(o['league'].get('format') == 'championship' for o in occurrences),
                'excluded': excluded,
                'files': len(files), 'truncated': len(result_files) > self.MAX_FILES or len(occurrences) >= self.MAX_OCCURRENCES,
                'errors': errors[:20], 'dateNote': 'Upload dates are publication dates. Cup periods inferred from them are estimates, not verified battle dates.'}}
            self._signature, self._value = sig, value
            return value

    @staticmethod
    def _video(a):
        return (a.get('video') or {}).get('id') or str(a.get('recording') or '').removesuffix('.mp4')

    def _occurrence(self, vid, index, b, raw, video, labels, leagues, feedback, schedule):
        b = copy.deepcopy(b)
        source_b = (raw.get('battles') or [{}])[index] if index < len(raw.get('battles') or []) else {}
        merged_answers = {**labels.get('verified', {}), **feedback.get('answers', {})}
        answers = [a for a in merged_answers.values()
                   if self._video(a) == vid and human(a) and (a.get('allBattles') or a.get('battle') == index)]
        result = b.get('result') or source_b.get('result') or 'Unknown'
        result_source = b.get('resultSource') or source_b.get('resultSource') or 'Unresolved'
        ending = None
        league_answers = sorted((a for a in answers if a.get('kind') == 'league' and a.get('value') != 'other'),
                                key=lambda a: str(a.get('answeredAt') or ''))
        league_labels = [a for a in league_answers if a.get('value') != 'rocket']
        per_b = next((x for x in labels.get('battles', []) if x.get('n') == index + 1), {})
        inferred = next((x for x in leagues.get('battles', []) if x.get('start') == b.get('start')), {})
        battle_type = self._battle_type(league_answers, per_b, labels, leagues, inferred)
        champion = battle_type == 'championship'
        league_id = (league_labels[-1]['value'] if league_labels and not champion else per_b.get('leagueId') or labels.get('leagueId')
                     or inferred.get('best') or video.get('leagueId') or (leagues.get('video') or {}).get('leagueId'))
        if champion and not str(league_id or '').startswith('championship'):
            league_id = inferred.get('best') if str(inferred.get('best') or '').startswith('championship') else 'championship'
        cup_id, _, cp_suffix = str(league_id or '').partition('@')
        cup = (schedule.get('cups') or {}).get(cup_id, {})
        cp = int(cp_suffix) if cp_suffix.isdigit() else 1500 if champion else inferred.get('cpCap') or cup.get('cp') or {'great': 1500, 'ultra': 2500, 'master': 10000, 'little': 500}.get(cup_id)
        league_name = 'Championship' if champion else {500: 'Little League', 1500: 'Great League', 2500: 'Ultra League', 10000: 'Master League'}.get(cp, 'Unassigned league')
        cup_name = 'Championship' if champion else 'all' if cup_id in ('great', 'ultra', 'master', 'little') else cup.get('name') or cup_id or 'all'
        league = {'id': league_id, 'cupId': cup_id or None, 'cup': cup_name, 'cp': cp, 'name': league_name,
                  'format': 'championship' if champion else 'gbl',
                  'source': 'reviewer' if league_labels or per_b.get('leagueId') or labels.get('leagueId') or labels.get('videoType') == 'championship' else 'inferred',
                  'confidence': 1 if league_labels else video.get('leagueConfidence')}
        for a in answers:
            if a.get('kind') == 'result':
                result, _, ending = str(a['value']).partition(':')
                result_source = 'reviewer'
        teams = {}
        for side in ('my', 'opponent'):
            members = b.get(side) or []
            details = source_b.get(side + 'Detail') or []
            teams[side] = [self._member(m, details[j] if j < len(details) else {}, side, answers, b)
                           for j, m in enumerate(members)]
        upload = date(video.get('uploadDate'))
        battle_date = date(b.get('battleDate') or raw.get('battleDate') or video.get('recordedDate'))
        date_verified = bool(battle_date and (b.get('dateVerified') or raw.get('dateVerified') or video.get('recordedDateVerified')))
        period = self._period(cup_id, cp, battle_date if date_verified else upload, schedule, date_verified)
        start, end = b.get('start', 0), b.get('end')
        url = 'https://www.youtube.com/watch?v=' + vid + '&t=' + str(max(0, int(start or 0))) + 's'
        events = b.get('events') or source_b.get('moves') or []
        hp = b.get('hp') or source_b.get('hp')
        # A reviewer's lead answer confirms the opponent's lead and puts it first.
        lead = next((a for a in sorted((a for a in answers if a.get('kind') == 'lead' and a.get('value') not in (None, 'other')),
                                       key=lambda a: str(a.get('answeredAt') or ''), reverse=True)), None)
        lead_confirmed = bool(b.get('leadConfirmed'))
        if lead:
            at = next((j for j, m in enumerate(teams['opponent']) if str(m.get('name') or '').lower() == str(lead['value']).lower()
                       or str(m.get('id') or '').lower() == str(lead['value']).lower()), None)
            if at is not None:
                teams['opponent'].insert(0, teams['opponent'].pop(at))
                lead_confirmed = True
        complete = {s: len(t) == 3 and all(m.get('id') and not m.get('uncertain') for m in t) for s, t in teams.items()}
        return {'id': vid + ':battle:' + str(index), 'battleIndex': index,
                'source': {'videoId': vid, 'url': url, 'title': video.get('title') or vid,
                           'channel': video.get('channel'), 'uploadDate': upload, 'license': video.get('license')},
                'league': league, 'cupRange': period, 'battleDate': battle_date, 'dateVerified': date_verified,
                'reviewed': bool(b.get('reviewed')), 'reviewStatus': 'reviewed' if b.get('reviewed') else 'partially reviewed' if answers else 'detected',
                'humanLabels': len(answers), 'complete': complete, 'battleType': battle_type,
                'battle': {'start': start, 'end': end, 'result': result, 'resultSource': result_source,
                           'ending': ending, 'my': teams['my'], 'opponent': teams['opponent'],
                           'leadConfirmed': lead_confirmed, 'events': events, 'hp': hp,
                           'shieldsUsed': b.get('shieldsUsed') or source_b.get('shieldsUsed'),
                           'fainted': b.get('fainted') or source_b.get('fainted'), 'flags': b.get('flags') or []},
                'timeline': self._timeline(vid, index, start, end, result, ending, teams, hp, events, b.get('effects') or [])}

    @staticmethod
    def _battle_type(league_answers, per_b, labels, leagues, inferred):
        """'rocket' (excluded from observed meta), 'championship' (own format) or 'gbl'.
        The latest human league answer wins over labels, labels over the automatic flags."""
        if league_answers:
            if league_answers[-1].get('value') == 'rocket':
                return 'rocket'
        elif per_b.get('battleType') == 'rocket' or (labels.get('videoType') == 'rocket' and not per_b.get('leagueId')):
            return 'rocket'
        elif inferred.get('rocket'):
            return 'rocket'
        if labels.get('championship') is False:
            return 'gbl'
        if labels.get('videoType') == 'championship' or labels.get('championship'):
            return 'championship'
        if (leagues.get('video') or {}).get('championship') or inferred.get('battleType') == 'championship':
            return 'championship'
        return 'gbl'

    @staticmethod
    def _member(member, detail, side, answers, battle):
        m = member if isinstance(member, dict) else {'name': member}
        inference = m.get('inference') or {}
        forms = inference.get('forms') or []
        form = (forms[0] if forms else None) or detail.get('form') or {}
        identity = form.get('id') or form.get('value') or m.get('id')
        if not identity and len(m.get('candidates') or []) == 1:
            identity = m['candidates'][0].get('id')
        shadow_p = inference.get('shadowP', detail.get('shadowP'))
        shadow = True if isinstance(shadow_p, (int, float)) and shadow_p >= .98 else False if isinstance(shadow_p, (int, float)) and shadow_p <= .02 else None
        if identity and identity.endswith('_shadow'):
            identity, shadow = identity.removesuffix('_shadow'), True
        moves = inference.get('moves') or []
        fast = (moves[0] if moves else None) or detail.get('fastMove') or {}
        key = m.get('key') or str(m.get('label') or m.get('name') or '').lower().replace(' ', '')
        reviewed = []
        for a in answers:
            if a.get('side') != side or a.get('key') != key:
                continue
            kind = a.get('kind')
            if kind == 'form':
                identity = str(a['value']).removesuffix('_shadow')
                form = {'id': identity, 'p': 1}
                if str(a['value']).endswith('_shadow'):
                    shadow = True
            elif kind == 'shadow':
                shadow = a['value'] if isinstance(a['value'], bool) else None
            elif kind == 'fastMove':
                fast = {'id': a['value'], 'p': 1}
            else:
                continue
            reviewed.append(kind)
        form_p = form.get('p', 1 if m.get('id') else None)
        uncertain = not identity or shadow is None or (form_p is not None and form_p < .98)
        charged = ((battle.get('evidence') or {}).get(side) or {}).get(key, {}).get('charged', [])
        return {'id': identity, 'name': m.get('label') or m.get('name') or detail.get('name') or identity or 'Unknown',
                'key': key, 'cp': m.get('cp') or detail.get('cp'), 'shadow': shadow, 'shadowP': shadow_p,
                'formConfidence': form_p, 'fastMove': fast.get('id') or fast.get('value'),
                'fastMoveConfidence': fast.get('p'), 'chargedMoves': charged, 'uncertain': uncertain,
                'reviewed': reviewed, 'first': m.get('first')}

    @staticmethod
    def _timeline(vid, index, start, end, result, ending, teams, hp, events, effects):
        def member(p):
            return {'key': p['key'], 'label': p['name'], 'species': p['id'], 'fastMove': p['fastMove'],
                    'fastMoveName': p['fastMove'], 'fastP': p['fastMoveConfidence'],
                    'shadowP': 1 if p['shadow'] is True else 0 if p['shadow'] is False else None, 'cp': p['cp']}
        compact_hp = None
        if isinstance(hp, dict):
            compact_hp = {'step': hp.get('step', .5)}
            for side in ('my', 'opponent'):
                compact_hp[side] = {key: [-1 if v is None else round(v * 100) for v in series]
                                    for key, series in (hp.get(side) or {}).items() if isinstance(series, list)}
        compact_events = []
        for e in events:
            if not isinstance(e, dict) or not isinstance(e.get('t'), (int, float)):
                continue
            if e.get('kind') in ('move', 'shield', 'faint', 'go', 'result', 'surrender') and e['t'] >= start - 1:
                compact_events.append({'t': round(e['t'] - start, 1), 'kind': e['kind'],
                                       'side': e.get('side'), 'actor': e.get('actor'), 'move': e.get('move')})
        for e in effects:
            if isinstance(e.get('t'), (int, float)):
                compact_events.append({'t': round(e['t'] - start, 1), 'kind': 'effect', 'side': e.get('side'), 'effect': e.get('kind')})
        return {'recording': vid + '.mp4', 'battle': index, 'start': start,
                'duration': max(0, (end or start) - start), 'result': result, 'ending': ending or 'normal',
                'my': [member(p) for p in teams['my']], 'opponent': [member(p) for p in teams['opponent']],
                'hp': compact_hp, 'events': sorted(compact_events, key=lambda e: e['t']),
                'available': bool(hp or events), 'coverage': 'measured HP and observed events' if hp else 'events only' if events else 'not saved'}

    @staticmethod
    def _period(cup, cp, anchor, schedule, verified):
        candidates = []
        if anchor:
            day = dt.date.fromisoformat(anchor)
            low = day if verified else day - dt.timedelta(days=14)
            for p in schedule.get('periods', []):
                if p.get('start', '9999') > day.isoformat() or p.get('end', '') < low.isoformat():
                    continue
                if any(f.get('id') == cup and (not cp or f.get('cp') == cp) for f in p.get('formats', [])):
                    candidates.append({'start': p['start'], 'end': p['end'], 'source': p.get('source'), 'season': p.get('season')})
        if len(candidates) == 1:
            return {**candidates[0], 'scheduleSource': candidates[0].get('source'), 'source': 'recording-date' if verified else 'upload-date', 'estimated': not verified, 'dateBasis': 'verified recording date' if verified else 'upload date with 14-day recording lag window'}
        return {'start': None, 'end': None, 'source': 'unassigned', 'estimated': True,
                'dateBasis': 'ambiguous upload-based recording period' if candidates else 'no verified recording date or matching schedule period',
                'candidates': candidates}
