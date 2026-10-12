"""Audit of the Observed meta schedule check on a harvester work dir (read-only).

    python3 -I observed_audit.py [WORK_DIR] [--web-root WEB] [--top N]

Builds the same catalog the app serves (observed.ObservedCatalog) and prints the per-battle status counts
(estimated / unassigned by reason) and the contradiction categories: observed cup, CP, source and what
the schedule ran at that CP in the upload-lag window, with an example title."""
import argparse
import collections
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import observed  # noqa: E402

DEFAULT_WORK = os.path.expanduser("~/Desktop/Projects/PoGo Recorder/src/yt-harvest")


def summarize(state):
    """{'status': Counter, 'reasons': Counter, 'repeat': int, 'categories': [(count, key, example)]}"""
    status, reasons, cats, ex = collections.Counter(), collections.Counter(), collections.Counter(), {}
    repeat = 0
    for o in state['occurrences']:
        r = o['cupRange']
        status[r['status']] += 1
        if r.get('reason'):
            reasons[r['reason']] += 1
        if r.get('repeat'):
            repeat += 1
        if r.get('reason') == 'disagrees':
            key = (o['league']['id'], o['league']['cp'], o['league'].get('source'),
                   tuple(sorted(s['id'] for s in r.get('scheduled', []))))
            cats[key] += 1
            ex.setdefault(key, (o['source']['title'][:70], o['source']['uploadDate'], o['source']['videoId']))
    return {'status': status, 'reasons': reasons, 'repeat': repeat,
            'categories': [(n, k, ex[k]) for k, n in cats.most_common()]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('work_dir', nargs='?', default=DEFAULT_WORK)
    ap.add_argument('--web-root', default=os.path.normpath(os.path.join(HERE, '..', '..')))
    ap.add_argument('--top', type=int, default=12)
    a = ap.parse_args(argv)
    s = summarize(observed.ObservedCatalog(a.work_dir, a.web_root).state())
    print('status  ', dict(s['status']), ' (estimated includes %d repeat-cup)' % s['repeat'])
    print('reasons ', dict(s['reasons']))
    print('contradictions by (observed id, cp, source, scheduled ids):')
    for n, k, e in s['categories'][:a.top]:
        print('  %4d %s  e.g. %s [%s %s]' % ((n, k) + e))


if __name__ == '__main__':
    main()
