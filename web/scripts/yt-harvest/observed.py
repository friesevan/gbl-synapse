"""Read-only, cached observed battle catalog with explicit detection/date provenance."""
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import threading

UPLOAD_LAG_DAYS = 14   # league.UPLOAD_LAG_DAYS: videos are uploaded up to two weeks after recording


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


MODEL_KINDS = {'shadow': 'shadow', 'fast': 'fastMove', 'form': 'form'}
# League answers that name no cup: "rocket" (a battle type) and "gbl" (the Rocket question's "not a Rocket battle").
NOT_A_LEAGUE = ('rocket', 'gbl')


def model_answers(feedback):
    """Model-resolved Shadow / fast-move / form answers (they passed the held-out resolution gate in
    learning-loop.cjs). Question ids encode where they apply: <source>:<recording>:<battle>:<side>:
    <key>:<kind>; questions about the creator's own Pokemon are asked once for every battle. LLM (external)
    resolutions are excluded. Human answers are applied after these, so they always win."""
    out = []
    for qid, r in (feedback.get('resolutions') or {}).items():
        if not isinstance(r, dict) or r.get('source') in ('freellm', 'local-llm', 'haiku') or r.get('value') is None:
            continue
        parts = str(qid).split(':')
        if len(parts) < 6 or parts[-1] not in MODEL_KINDS:
            continue
        try:
            battle = int(parts[-4])
        except ValueError:
            continue
        side = parts[-3]
        out.append({'qid': qid, 'kind': MODEL_KINDS[parts[-1]], 'side': side, 'key': parts[-2], 'battle': battle,
                    'allBattles': side == 'my', 'recording': parts[1], 'value': r['value'], 'source': 'model'})
    return out


# Result sources (core.js inferResult). Older saved results used the long names.
LEGACY_RESULT_SOURCES = {'Poké Ball count': 'faints', 'surrender dialog': 'surrender'}
RESULT_RULE_SOURCES = ('timeline', 'policy')


def result_resolutions(feedback):
    """Result questions settled by the battle timeline (learning-loop.cjs resultResolution, re-derived on every
    refit), by (video id, battle index): "timeline" records carry the inferred result (rule: faints / surrender),
    "policy" records mark the result unresolvable (no result screen in the footage)."""
    out = {}
    for qid, r in (feedback.get('resolutions') or {}).items():
        if not isinstance(r, dict) or r.get('source') not in RESULT_RULE_SOURCES:
            continue
        parts = str(qid).split(':')
        if len(parts) < 4 or parts[-1] != 'result':
            continue
        try:
            battle = int(parts[-2])
        except ValueError:
            continue
        out[(parts[-3].removesuffix('.mp4'), battle)] = r
    return out


QUESTION_KINDS = {'shadow': 'shadow', 'form': 'form', 'fast': 'fastMove'}
PVPOKE_CPS = (500, 1500, 2500, 10000)
PVPOKE_SPECIES = 300


def question_index(directory):
    """Validate questions about members, parsed from the question file names (the file name is the qid:
    <source>:<recording>:<battle>:<side>:<key>:<kind>). Creator-side questions are asked once for every
    battle, so they are indexed under battle 'all'."""
    out = {}
    try:
        names = sorted(f.name for f in Path(directory).iterdir() if f.suffix == '.json')
    except OSError:
        return out
    for name in names:
        qid = name[:-5]
        parts = qid.split(':')
        if len(parts) < 6 or parts[-1] not in QUESTION_KINDS:
            continue
        try:
            battle = int(parts[-4])
        except ValueError:
            continue
        side, key, kind = parts[-3], parts[-2], QUESTION_KINDS[parts[-1]]
        out.setdefault(('all' if side == 'my' else battle, side, key, kind), []).append(qid)
    return out


def question_status(qid, feedback):
    if human((feedback.get('answers') or {}).get(qid)):
        return 'answered'
    r = (feedback.get('resolutions') or {}).get(qid)
    if isinstance(r, dict) and r.get('value') is not None:
        return 'resolved'
    return 'open'


def human(answer):
    return (isinstance(answer, dict) and answer.get('value') is not None
            and answer.get('source') != 'model' and not answer.get('modelResolved'))


class ObservedCatalog:
    MAX_FILES = 5000
    MAX_OCCURRENCES = 10000

    def __init__(self, work_dir, web_root, background=False):
        self.background = background   # web app: serve the previous catalog while rebuilding
        self.work = Path(work_dir)
        self.web = Path(web_root)
        self.registry = self.web / 'tests/meta-benchmark/sources/registry.json'
        self.schedule = self.web / 'scripts/yt-harvest/data/gbl-schedule.json'
        self.lock = threading.RLock()
        self._signature = None
        self._value = None
        self._questions = {}
        self._pvpoke = (None, None)
        self._videos = {}          # stem -> (key, rows, rocket count, error) — per-video cache
        self._building = False     # a background rebuild is running
        self.build_lock = threading.Lock()

    @staticmethod
    def _qid_video(qid):
        """Video id from a question id (<source>:<recording>.mp4:...), or None."""
        for part in str(qid).split(':'):
            if part.endswith('.mp4'):
                return part.removesuffix('.mp4')
        return None

    def _feedback_views(self, feedback):
        """Per-video slices of feedback.json (answers + resolutions), so each video's rows only look at its own
        labels. Records that can't be attributed to a video are shared by every view."""
        answers, resolutions, shared_a, shared_r = {}, {}, {}, {}
        for qid, a in (feedback.get('answers') or {}).items():
            vid = self._video(a) if isinstance(a, dict) else None
            vid = vid or self._qid_video(qid)
            (answers.setdefault(vid, {}) if vid else shared_a)[qid] = a
        for qid, r in (feedback.get('resolutions') or {}).items():
            vid = self._qid_video(qid)
            (resolutions.setdefault(vid, {}) if vid else shared_r)[qid] = r
        base = {k: v for k, v in feedback.items() if k not in ('answers', 'resolutions', 'questions', 'predictions', 'history')}

        def view(stem):
            a, r = answers.get(stem, {}), resolutions.get(stem, {})
            if shared_a:
                a = {**shared_a, **a}
            if shared_r:
                r = {**shared_r, **r}
            return {**base, 'answers': a, 'resolutions': r}
        return view

    def state(self):
        """Latest catalog. When files changed since the last build and a previous catalog exists, the previous one
        is returned at once and the rebuild runs in the background (stale-while-revalidate): a busy harvester
        changes files every minute, and a request must never wait for a full rebuild."""
        with self.lock:
            value = self._value
            if value is not None and self.background:
                if not self._building and self._signature != self._current_signature():
                    self._building = True
                    threading.Thread(target=self._rebuild_in_background, name='observed-rebuild', daemon=True).start()
                return value
        return self._build()

    def _rebuild_in_background(self):
        try:
            self._build()
        except Exception:  # keep serving the previous catalog
            pass
        finally:
            with self.lock:
                self._building = False

    def _current_signature(self):
        files = self._result_files()[:self.MAX_FILES]
        version = (read(self.work / 'feedback.json', {}).get('learning') or {}).get('version', 0)
        return self._signature_for(files, version)

    def _result_files(self):
        return sorted(p for p in (self.work / 'results').glob('*.json')
                      if not p.name.endswith(('.leagues.json', '.learned.json')) and p.name != 'batch-summary.json')

    def _signature_for(self, files, version):
        refits = self.work / 'learning' / ('refit-' + str(version))
        watched = [self.registry, self.schedule, self.work / 'feedback.json', *self._pvpoke_files()]
        for p in files:
            watched.extend([p, p.with_name(p.stem + '.leagues.json'), self.work / 'labels' / p.name,
                            refits / p.name, self.work / 'validation' / p.stem])
        return tuple(stamp(p) for p in watched)

    def _build(self):
        with self.build_lock:
            result_files = self._result_files()
            files = result_files[:self.MAX_FILES]
            feedback = read(self.work / 'feedback.json', {})
            version = (feedback.get('learning') or {}).get('version', 0)
            refits = self.work / 'learning' / ('refit-' + str(version))
            pvpoke_files = self._pvpoke_files()
            watched = [self.registry, self.schedule, self.work / 'feedback.json', *pvpoke_files]
            for p in files:
                watched.extend([p, p.with_name(p.stem + '.leagues.json'), self.work / 'labels' / p.name,
                                refits / p.name, self.work / 'validation' / p.stem])
            sig = tuple(stamp(p) for p in watched)
            if self._signature == sig and self._value is not None:
                return self._value
            view_for = self._feedback_views(feedback)
            schedule_stamp = stamp(self.schedule)
            registry = read(self.registry, [])
            videos = registry if isinstance(registry, list) else registry.get('videos', [])
            by_id = {v.get('id'): v for v in videos if isinstance(v, dict)}
            schedule = read(self.schedule, {})
            occurrences, errors, videos_with_battles = [], [], set()
            excluded = {'rocket': 0}
            seen = set()
            for p in files:
                fitted = refits / p.name
                fb = view_for(p.stem)
                entry = by_id.get(p.stem, {})
                key = (stamp(p), stamp(p.with_name(p.stem + '.leagues.json')), stamp(self.work / 'labels' / p.name),
                       stamp(fitted), stamp(self.work / 'validation' / p.stem), schedule_stamp, version,
                       hashlib.sha256(json.dumps([entry, fb['answers'], fb['resolutions']], sort_keys=True, default=str)
                                      .encode()).hexdigest())
                seen.add(p.stem)
                cached = self._videos.get(p.stem)
                if not cached or cached[0] != key:
                    cached = self._videos[p.stem] = (key, *self._video_rows(p, fitted, fb, entry, schedule))
                _, rows, rocket, error = cached
                if error:
                    errors.append(error)
                    continue
                excluded['rocket'] += rocket
                if rows:
                    videos_with_battles.add(p.stem)
                for row in rows:
                    occurrences.append(row)
                    if len(occurrences) >= self.MAX_OCCURRENCES:
                        break
                if len(occurrences) >= self.MAX_OCCURRENCES:
                    break
            for stem in [k for k in self._videos if k not in seen]:
                del self._videos[stem]
            occurrences.sort(key=lambda o: (o['source'].get('uploadDate') or '', o['source']['videoId'], o['battle']['start']), reverse=True)
            revision = hashlib.sha256(repr(sig).encode()).hexdigest()[:20]
            periods, by_league = {}, {}
            for o in occurrences:
                r = o['cupRange']
                periods[r['status']] = periods.get(r['status'], 0) + 1
                row = by_league.setdefault(o['league']['name'], {})
                row[r['status']] = row.get(r['status'], 0) + 1
                if r.get('reason'):
                    periods[r['reason']] = periods.get(r['reason'], 0) + 1
                if r.get('repeat'):
                    periods['repeat-cup'] = periods.get('repeat-cup', 0) + 1
            value = {'revision': revision, 'occurrences': occurrences,
                     'schedule': {'seasons': [{k: s.get(k) for k in ('season', 'name', 'start', 'end', 'source')}
                                              for s in schedule.get('seasons', []) if isinstance(s, dict)],
                                  'lagDays': UPLOAD_LAG_DAYS,
                                  'cups': {k: c.get('name') for k, c in (schedule.get('cups') or {}).items() if isinstance(c, dict)}},
                     'pvpoke': self.pvpoke(pvpoke_files),
                     'summary': {
                'periodStatus': periods, 'cupStatusByLeague': by_league,
                'videos': len(videos_with_battles), 'battles': len(occurrences),
                'completeCreatorTeams': sum(o['complete']['my'] for o in occurrences),
                'completeOpponentTeams': sum(o['complete']['opponent'] for o in occurrences),
                'incompleteBattles': sum(not all(o['complete'].values()) for o in occurrences),
                'championshipBattles': sum(o['league'].get('format') == 'championship' for o in occurrences),
                'excluded': excluded,
                'files': len(files), 'truncated': len(result_files) > self.MAX_FILES or len(occurrences) >= self.MAX_OCCURRENCES,
                'errors': errors[:20], 'dateNote': 'Upload dates are publication dates. Cup periods inferred from them are estimates, not verified battle dates.'}}
            with self.lock:
                self._signature, self._value = sig, value
            return value

    @staticmethod
    def _video(a):
        return (a.get('video') or {}).get('id') or str(a.get('recording') or '').removesuffix('.mp4')

    def _video_rows(self, p, fitted, feedback, entry, schedule):
        """Rows for one video: (rows, rocket battles excluded, error or None). `feedback` is this video's slice."""
        raw = read(p, None)
        if not isinstance(raw, dict):
            return [], 0, {'videoId': p.stem, 'error': 'Result file is unavailable or incomplete'}
        # A completed refit must not supersede a subsequently re-extracted video.
        if fitted.exists() and fitted.stat().st_mtime_ns >= p.stat().st_mtime_ns:
            updated = read(fitted, {})
            if isinstance(updated, dict) and isinstance(updated.get('full'), list):
                raw = updated
        full = raw.get('full') or raw.get('battles') or []
        if not isinstance(full, list):
            return [], 0, None
        labels = read(self.work / 'labels' / p.name, {})
        questions = self._question_index(p.stem, feedback)
        leagues = read(p.with_name(p.stem + '.leagues.json'), {})
        video = {**entry, **(raw.get('video') or {})}
        for a in feedback.get('answers', {}).values():
            if self._video(a) == p.stem and isinstance(a.get('video'), dict):
                video = {**a['video'], **video}
        rows, rocket = [], 0
        for i, b in enumerate(full):
            if not isinstance(b, dict):
                continue
            row = self._occurrence(p.stem, i, b, raw, video, labels, leagues, feedback, schedule, questions)
            if row['battleType'] == 'rocket':
                rocket += 1   # Team Rocket battles train the extractor but are never meta
                continue
            rows.append(row)
        return rows, rocket, None

    def _question_index(self, stem, feedback):
        directory = self.work / 'validation' / stem
        st = stamp(directory)
        cached = self._questions.get(stem)
        if not cached or cached[0] != st:
            cached = self._questions[stem] = (st, question_index(directory))
        return {k: [(q, question_status(q, feedback)) for q in v] for k, v in cached[1].items()}

    def _occurrence(self, vid, index, b, raw, video, labels, leagues, feedback, schedule, questions=None):
        b = copy.deepcopy(b)
        source_b = (raw.get('battles') or [{}])[index] if index < len(raw.get('battles') or []) else {}
        merged_answers = {**labels.get('verified', {}), **feedback.get('answers', {})}
        answers = [a for a in merged_answers.values()
                   if self._video(a) == vid and human(a) and (a.get('allBattles') or a.get('battle') == index)]
        modelled = [a for a in model_answers(feedback)
                    if self._video(a) == vid and (a['allBattles'] or a['battle'] == index)]
        result = b.get('result') or source_b.get('result') or 'Unknown'
        result_source = b.get('resultSource') or source_b.get('resultSource') or 'Unresolved'
        result_source = LEGACY_RESULT_SOURCES.get(result_source, result_source)
        ending = None
        # Results inferred from the timeline (current rules, applied at the last refit) count like detected ones;
        # a read result screen keeps priority, and human answers (below) win over both.
        rule = None if result_source in ('result screen', 'reviewer') else result_resolutions(feedback).get((vid, index))
        if rule and rule.get('source') == 'timeline' and rule.get('value'):
            result, _, ending = str(rule['value']).partition(':')
            ending = ending or None
            result_source = rule.get('rule') or 'faints'
        elif rule and rule.get('source') == 'policy':
            result, ending, result_source = 'Unknown', None, 'unresolvable'
        league_answers = sorted((a for a in answers if a.get('kind') == 'league' and a.get('value') not in (None, 'other')),
                                key=lambda a: str(a.get('answeredAt') or ''))
        league_labels = [a for a in league_answers if a.get('value') not in NOT_A_LEAGUE]
        per_b = next((x for x in labels.get('battles', []) if x.get('n') == index + 1), {})
        inferred = next((x for x in leagues.get('battles', []) if x.get('start') == b.get('start')), {})
        battle_type = self._battle_type(league_answers, per_b, labels, leagues, inferred)
        champion = battle_type == 'championship'
        # The league comes from the CPs; the cup from the video's text (league.battle_cup, stored in the sidecar) or a
        # reviewer's label. The schedule alone never assigns a cup: without one the battle stays under its league with
        # an unknown cup. Sidecars written before this rule (no cupStatus) count as uncaptured.
        reviewer_cup = league_labels[-1]['value'] if league_labels else per_b.get('leagueId') or labels.get('leagueId')
        cup_source = 'reviewer' if reviewer_cup else inferred.get('cupSource') if 'cupStatus' in inferred else None
        league_id = reviewer_cup or (inferred.get('cup') if 'cupStatus' in inferred else None)
        if champion:
            league_id = (league_id if str(league_id or '').startswith('championship') else inferred.get('best')
                         if str(inferred.get('best') or '').startswith('championship') else 'championship')
            cup_source = cup_source or 'title'
        cup_id, _, cp_suffix = str(league_id or '').partition('@')
        cup = (schedule.get('cups') or {}).get(cup_id, {})
        base_cp = {'great': 1500, 'ultra': 2500, 'master': 10000, 'little': 500}
        cp = (int(cp_suffix) if cp_suffix.isdigit() else 1500 if champion else inferred.get('cpCap') or cup.get('cp')
              or base_cp.get(cup_id) or base_cp.get(inferred.get('league')))
        league_name = 'Championship' if champion else {500: 'Little League', 1500: 'Great League', 2500: 'Ultra League', 10000: 'Master League'}.get(cp, 'Unassigned league')
        cup_name = ('Championship' if champion else 'unknown' if not cup_id else 'all' if cup_id in base_cp
                    else inferred.get('cupName') if inferred.get('cup') == league_id and inferred.get('cupName') else cup.get('name') or cup_id)
        league = {'id': league_id, 'cupId': cup_id or None, 'cup': cup_name, 'cp': cp, 'name': league_name,
                  'format': 'championship' if champion else 'gbl', 'cupSource': cup_source,
                  'source': 'reviewer' if reviewer_cup or labels.get('videoType') == 'championship' else 'inferred',
                  'confidence': 1 if reviewer_cup else inferred.get('cupConfidence')}
        for a in answers:
            if a.get('kind') == 'result':
                result, _, ending = str(a['value']).partition(':')
                result_source = 'reviewer'
        teams = {}
        for side in ('my', 'opponent'):
            members = b.get(side) or []
            details = source_b.get(side + 'Detail') or []
            teams[side] = [self._member(m, details[j] if j < len(details) else {}, side, modelled + answers, b,
                                        self._member_questions(questions or {}, index, side, m))
                           for j, m in enumerate(members)]
        upload = date(video.get('uploadDate'))
        battle_date = date(b.get('battleDate') or raw.get('battleDate') or video.get('recordedDate'))
        date_verified = bool(battle_date and (b.get('dateVerified') or raw.get('dateVerified') or video.get('recordedDateVerified')))
        uncaptured = None if league_id else 'no-league' if not cp else (inferred.get('cupReason') if 'cupStatus' in inferred
                                                                         else 'not-refined') or 'no-cup-named'
        period = self._period(cup_id, cp, battle_date if date_verified else upload, schedule, date_verified,
                              'championship' if champion else uncaptured)
        start, end = b.get('start', 0), b.get('end')
        url = 'https://www.youtube.com/watch?v=' + vid + '&t=' + str(max(0, int(start or 0))) + 's'
        events = b.get('events') or source_b.get('moves') or []
        hp = b.get('hp') or source_b.get('hp')
        # A reviewer's lead answer confirms the opponent's lead and puts it first.
        lead = next((a for a in sorted((a for a in answers if a.get('kind') == 'lead' and a.get('value') not in (None, 'other')),
                                       key=lambda a: str(a.get('answeredAt') or ''), reverse=True)), None)
        lead_confirmed = bool(b.get('leadConfirmed'))
        if lead:
            # The value is the member key (since lead options show the full identity); older answers hold the name.
            value = str(lead['value']).lower()
            at = next((j for j, m in enumerate(teams['opponent']) if value in (str(m.get('key') or '').lower(),
                       str(m.get('name') or '').lower(), str(m.get('id') or '').lower())), None)
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
    def _member_questions(questions, index, side, member):
        m = member if isinstance(member, dict) else {'name': member}
        key = m.get('key') or str(m.get('label') or m.get('name') or '').lower().replace(' ', '')
        out = {}
        for kind in ('shadow', 'form', 'fastMove'):
            found = questions.get(('all' if side == 'my' else index, side, key, kind)) or []
            if found:
                # An open question is the useful link; otherwise the settled one, for its status.
                out[kind] = dict(zip(('qid', 'status'), next((q for q in found if q[1] == 'open'), found[-1])))
        return out

    @staticmethod
    def _member(member, detail, side, answers, battle, questions=None):
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
            if a.get('source') != 'model':
                reviewed.append(kind)
        form_p = form.get('p', 1 if m.get('id') else None)
        uncertain = not identity or shadow is None or (form_p is not None and form_p < .98)
        # Why a member keeps its lineup out of the identified teams (the same three tests as `uncertain`).
        questions = questions or {}
        why = []
        if not identity:
            why.append({'kind': 'species', 'candidates': [c.get('id') for c in (m.get('candidates') or [])[:3] if isinstance(c, dict)],
                        'question': questions.get('form')})
        elif form_p is not None and form_p < .98:
            alternatives = [{'id': f.get('id') or f.get('value'), 'p': f.get('p')} for f in forms[:3] if isinstance(f, dict)]
            why.append({'kind': 'form', 'p': form_p, 'alternatives': alternatives, 'question': questions.get('form')})
        if shadow is None:
            why.append({'kind': 'shadow', 'p': shadow_p if isinstance(shadow_p, (int, float)) else None,
                        'question': questions.get('shadow')})
        charged = ((battle.get('evidence') or {}).get(side) or {}).get(key, {}).get('charged', [])
        return {'id': identity, 'name': m.get('label') or m.get('name') or detail.get('name') or identity or 'Unknown',
                'key': key, 'cp': m.get('cp') or detail.get('cp'), 'shadow': shadow, 'shadowP': shadow_p,
                'formConfidence': form_p, 'fastMove': fast.get('id') or fast.get('value'),
                'fastMoveConfidence': fast.get('p'), 'chargedMoves': charged, 'uncertain': uncertain,
                'reviewed': reviewed, 'first': m.get('first'), 'why': why,
                'fastQuestion': questions.get('fastMove')}

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
    def _period(cup, cp, anchor, schedule, verified, unscheduled=None):
        """Checks the battle's cup (taken from the video's text, or a reviewer's label) against the GBL schedule.
        status: text-confirmed (the schedule ran this cup: a verified recording date inside one of its periods, or the
        upload date with its lag window overlapping them; repeat=True when it ran in several periods of the window,
        which are listed and spanned), text-only (reason: disagrees = the schedule ran other formats at this CP on those
        dates, never this cup, listed in `scheduled`; no-record = no schedule period at this CP covers the dates, or no
        date; championship = not on the GBL schedule), uncaptured (no cup in the text: reason says why, and
        `scheduled` lists what the schedule ran at the battle's CP, a hint only, never assigned)."""
        base = {'start': None, 'end': None, 'source': 'unassigned', 'estimated': True}
        day = dt.date.fromisoformat(anchor) if anchor else None
        low = (day if verified else day - dt.timedelta(days=UPLOAD_LAG_DAYS)) if day else None
        candidates, active = [], []
        for p in schedule.get('periods', []) if day else []:
            if p.get('start', '9999') > day.isoformat() or p.get('end', '') < low.isoformat():
                continue
            for f in p.get('formats', []):
                if cp and f.get('cp') != cp:
                    continue
                active.append({'id': f.get('id'), 'name': f.get('name') or ((schedule.get('cups') or {}).get(f.get('id')) or {}).get('name'),
                               'start': p.get('start'), 'end': p.get('end')})
                if f.get('id') == cup:
                    candidates.append({'id': f.get('id'), 'start': p['start'], 'end': p['end'], 'source': p.get('source'), 'season': p.get('season'),
                                       'confidence': p.get('confidence')})
        seen = {}
        for a in active:
            seen.setdefault((a['id'], a['name']), a)
        scheduled = list(seen.values())[:6]
        window = {'from': low.isoformat(), 'to': day.isoformat()} if day else None
        if unscheduled == 'championship':
            return {**base, 'status': 'text-only', 'reason': 'championship', 'candidates': [], 'scheduled': [],
                    'dateBasis': 'championship battles are not on the GBL schedule'}
        if unscheduled or not cup:
            reason = unscheduled or 'no-cup-named'
            return {**base, 'status': 'uncaptured', 'reason': reason, 'candidates': [], 'window': window,
                    'scheduled': [] if reason == 'no-league' else scheduled,
                    'dateBasis': 'no league was identified' if reason == 'no-league'
                    else 'the video text names no cup for this battle; the schedule is a hint only'}
        if not day:
            return {**base, 'status': 'text-only', 'reason': 'no-record', 'candidates': [], 'scheduled': [],
                    'dateBasis': 'no verified recording date or upload date'}
        ids = {c['id'] for c in candidates}
        if len(candidates) > 1 and len(ids) == 1:
            # The same cup ran in more than one period of the window (a repeat week): not ambiguous for the meta, which
            # is assigned to the cup. The range spans the periods, listed in `periods`.
            span = {'start': min(c['start'] for c in candidates), 'end': max(c['end'] for c in candidates)}
            seasons = {c.get('season') for c in candidates}
            return {**span, 'source': 'recording-date' if verified else 'upload-date', 'scheduleSource': candidates[0].get('source'),
                    'season': seasons.pop() if len(seasons) == 1 else None, 'confidence': candidates[0].get('confidence'),
                    'estimated': not verified, 'status': 'text-confirmed', 'repeat': True,
                    'periods': [{k: c.get(k) for k in ('start', 'end', 'season')} for c in candidates],
                    'candidates': candidates, 'window': window,
                    'uploadInPeriod': None if verified else any(c['start'] <= anchor <= c['end'] for c in candidates),
                    'dateBasis': 'repeat cup: %d periods of this cup in the %s' % (
                        len(candidates), 'verified recording date' if verified else 'upload-date lag window')}
        if len(candidates) == 1:
            c = candidates[0]
            return {**c, 'scheduleSource': c.get('source'), 'source': 'recording-date' if verified else 'upload-date',
                    'estimated': not verified, 'status': 'text-confirmed', 'window': window,
                    'uploadInPeriod': None if verified else c['start'] <= anchor <= c['end'],
                    'dateBasis': 'verified recording date' if verified else 'upload date with %d-day recording lag window' % UPLOAD_LAG_DAYS}
        if active:
            return {**base, 'status': 'text-only', 'reason': 'disagrees', 'contradiction': True, 'window': window,
                    'candidates': [], 'scheduled': scheduled,
                    'dateBasis': 'the schedule ran other formats at this CP on these dates, never this cup'}
        return {**base, 'status': 'text-only', 'reason': 'no-record', 'window': window, 'candidates': [], 'scheduled': [],
                'dateBasis': 'no schedule period at this CP covers these dates'}

    @staticmethod
    def _pvpoke_paths(web):
        data = web / 'includes/pro/data'
        return {cp: (data / ('league-%d.json' % cp), data / ('overrides-%d.json' % cp)) for cp in PVPOKE_CPS}

    def _pvpoke_files(self):
        return [f for pair in self._pvpoke_paths(self.web).values() for f in pair] + [self.web / 'includes/pro/data/gamemaster.json']

    def pvpoke(self, files=None):
        """PvPoke's open-league per-Pokemon weights and the share of teams expected to contain each species when
        teams are drawn independently by weight ** 1.25 (usage_export.prior_presence, the trainer's prior), over the
        same 300-species population as training/team-search/common.cjs. Cached on the data files' stamps."""
        sig = tuple(stamp(f) for f in (files or self._pvpoke_files()))
        if self._pvpoke[0] == sig:
            return self._pvpoke[1]
        import usage_export   # lazy: usage_export imports this module
        gm = read(self.web / 'includes/pro/data/gamemaster.json', {})
        dex = {p.get('speciesId'): p.get('dex') for p in ((gm.get('pokemon') if isinstance(gm, dict) else None) or []) if isinstance(p, dict)}
        out = {}
        for cp, (league_path, override_path) in self._pvpoke_paths(self.web).items():
            published = read(league_path, {})
            published = published.get('overall') if isinstance(published, dict) else None
            overrides = read(override_path, [])
            if not isinstance(published, list) or not isinstance(overrides, list):
                continue
            weights = {r.get('speciesId'): r.get('weight') for r in overrides if isinstance(r, dict)}
            rows = []
            for rank, r in enumerate(published, 1):
                if not isinstance(r, dict):
                    continue
                w = weights.get(r.get('speciesId'))
                w = w if isinstance(w, (int, float)) else 1
                if w > 0 and r.get('speciesId') in dex:
                    rows.append((r['speciesId'], w, rank))
            rows.sort(key=lambda r: (-r[1], r[2]))
            pool = {i: {'weight': w, 'dex': dex[i], 'rank': rank} for i, w, rank in rows[:PVPOKE_SPECIES]}
            if len({p['dex'] for p in pool.values()}) < 3:
                continue
            presence = usage_export.prior_presence(pool, samples=20000)
            out[str(cp)] = {'source': 'PvPoke open-league rankings (%s) with per-Pokemon weights (%s)' % (league_path.name, override_path.name),
                            'species': {i: {'weight': p['weight'], 'rank': p['rank'], 'presence': round(presence.get(i, 0), 5)}
                                        for i, p in pool.items()}}
        self._pvpoke = (sig, out)
        return out
