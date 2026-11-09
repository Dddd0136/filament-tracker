#!/usr/bin/env python3
# Filament tracker: reports a finished/cancelled print to the Google Apps Script web app.
# Called from Klipper:
#   RUN_SHELL_COMMAND CMD=spool_report PARAMS="done <filament_mm> <print_s> <total_s> <progress 0..1>"
#   argv[1] = done | cancelled | test | flush
# Manual use over SSH:
#   python3 ~/klipper_config/spool_report.py check              - diagnostics
#   python3 ~/klipper_config/spool_report.py resend <report_id> - re-send the last finished job
#           to fill new columns (times, slicer data, thumbnail) of an existing row;
#           the spool is NOT charged again
#   argv[2] = filament used, mm (printer.print_stats.filament_used)
#   argv[3..5] = print_duration, total_duration, virtual_sdcard.progress (optional fallbacks)
# Collected: print times, filament used, progress, slicer metadata (estimates, layer height,
# temperatures...) and the model thumbnail. Reports are queued in ~/spool_queue.jsonl and
# re-sent later if the internet is down.
# Python 3.7 compatible, standard library only. Output is ASCII only (old Klipper).
import sys, os, json, time, fcntl, base64, urllib.request, urllib.parse

HOME = os.path.expanduser('~')
CONF = os.path.join(HOME, 'klipper_config', 'spool_tracker.conf')
GCODE_DIR = os.path.join(HOME, 'gcode_files')
QUEUE = os.path.join(HOME, 'spool_queue.jsonl')
LOCK = QUEUE + '.lock'
LOG = os.path.join(HOME, 'klipper_logs', 'spool_tracker.log')
MOONRAKER = 'http://127.0.0.1:7125'
META_KEYS = ('estimated_time', 'filament_total', 'filament_weight_total', 'layer_height',
             'first_layer_height', 'object_height', 'layer_count', 'first_layer_extr_temp',
             'first_layer_bed_temp', 'nozzle_diameter', 'filament_type', 'filament_name',
             'slicer', 'slicer_version')
THUMB_MAX_PX = 400


def log(msg):
    try:
        with open(LOG, 'a') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + msg + '\n')
    except Exception:
        pass


def read_conf():
    c = {}
    try:
        with open(CONF) as f:
            for line in f:
                line = line.strip()
                if not line or line[0] in '#;' or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                c[k.strip().lower()] = v.strip()
    except Exception as e:
        log('conf error: %s' % e)
    return c


def moonraker(path, timeout=3):
    with urllib.request.urlopen(MOONRAKER + path, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))['result']


def collect(status, mm, extra):
    now = int(time.time())
    rec = {'id': '%d-%d' % (int(time.time() * 1000), os.getpid()), 'ts': now,
           'status': status, 'mm': round(mm, 1), 'file': ''}
    # values passed by the Klipper macro (used if the query below fails)
    if len(extra) >= 2:
        rec['print_s'], rec['total_s'] = round(extra[0]), round(extra[1])
        rec['start_ts'] = now - rec['total_s'] if rec['total_s'] else None
    if len(extra) >= 3:
        rec['progress'] = 100 if status == 'done' else round(extra[2] * 100, 1)
    try:
        st = moonraker('/printer/objects/query?print_stats&virtual_sdcard')['status']
        ps, sd = st.get('print_stats', {}), st.get('virtual_sdcard', {})
        rec['file'] = ps.get('filename', '') or ''
        rec['print_s'] = round(ps.get('print_duration', 0) or 0)
        rec['total_s'] = round(ps.get('total_duration', 0) or 0)
        rec['start_ts'] = now - rec['total_s'] if rec['total_s'] else None
        rec['progress'] = 100 if status == 'done' else round((sd.get('progress', 0) or 0) * 100, 1)
    except Exception as e:
        log('print_stats query failed: %s' % e)
    if rec['file']:
        add_metadata(rec)
    return rec


def add_metadata(rec):
    try:
        md = moonraker('/server/files/metadata?filename=' + urllib.parse.quote(rec['file']))
        rec['meta'] = dict((k, md[k]) for k in META_KEYS if md.get(k) not in (None, ''))
        thumbs = [t for t in (md.get('thumbnails') or []) if t.get('relative_path')]
        small = [t for t in thumbs if (t.get('width') or 0) <= THUMB_MAX_PX] or thumbs
        if small:
            best = max(small, key=lambda t: t.get('width') or 0)
            path = os.path.join(GCODE_DIR, os.path.dirname(rec['file']), best['relative_path'])
            with open(path, 'rb') as f:
                rec['thumb'] = base64.b64encode(f.read()).decode('ascii')
    except Exception as e:
        log('metadata/thumbnail not available: %s' % e)
        rec['meta_error'] = str(e)


class Locked(object):
    def __enter__(self):
        self.f = open(LOCK, 'a')
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def enqueue(rec):
    with Locked():
        with open(QUEUE, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def send(url, token, rec):
    # POST; Apps Script answers 302 and urllib follows it with GET to fetch the result.
    body = json.dumps({'token': token, 'data': rec}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'text/plain;charset=utf-8'})
    with urllib.request.urlopen(req, timeout=40) as r:
        res = json.loads(r.read().decode('utf-8'))
    if not res.get('ok'):
        raise RuntimeError('server: %s' % res.get('error'))
    return res


def flush():
    c = read_conf()
    url, token = c.get('url', ''), c.get('token', '')
    if not url.startswith('https://') or not token:
        log('not configured: set url= and token= in %s' % CONF)
        return
    with Locked():
        try:
            with open(QUEUE, encoding='utf-8') as f:
                lines = [l for l in f.read().splitlines() if l.strip()]
        except FileNotFoundError:
            return
        keep = []
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                log('dropped bad line')
                continue
            try:
                res = send(url, token, rec)
                log('sent %s %s mm -> %s' % (rec.get('status'), rec.get('mm'), json.dumps(res, ensure_ascii=True)))
            except Exception as e:
                log('send failed (%s), will retry later' % e)
                keep.append(line)
        with open(QUEUE, 'w', encoding='utf-8') as f:
            f.write(''.join(l + '\n' for l in keep))


def detach_and_flush():
    # Return to Klipper immediately; send in a background process.
    if os.fork() > 0:
        return
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    try:
        flush()
    finally:
        os._exit(0)


def last_jobs(n=5):
    return moonraker('/server/history/list?limit=%d&order=desc' % n, timeout=5).get('jobs', [])


def cmd_check():
    import subprocess
    print('Printer time : %s' % time.strftime('%Y-%m-%d %H:%M:%S %Z'))
    try:
        out = subprocess.check_output(['chronyc', 'tracking'], stderr=subprocess.STDOUT).decode()
        print('chrony       : ' + ' | '.join(l.strip() for l in out.splitlines() if l.startswith(('Reference', 'System time', 'Leap'))))
    except Exception as e:
        print('chrony       : NOT available (%s)' % e)
    c = read_conf()
    print('Config       : url %s, token %s' % ('OK' if c.get('url', '').startswith('https://') else 'MISSING',
                                               'OK' if c.get('token') else 'MISSING'))
    try:
        with open(QUEUE) as f:
            q = [l for l in f if l.strip()]
    except FileNotFoundError:
        q = []
    print('Queue        : %d report(s) waiting' % len(q))
    print('Last jobs (printer clock):')
    try:
        for j in last_jobs(3):
            rec = {'file': j.get('filename', '')}
            add_metadata(rec)
            m = rec.get('meta', {})
            print('  %s  %-9s %6.1f m  print %s  est %s  thumb %s  %s' % (
                time.strftime('%Y-%m-%d %H:%M', time.localtime(j.get('end_time') or j.get('start_time') or 0)),
                j.get('status'), (j.get('filament_used') or 0) / 1000.0,
                fmt_dur(j.get('print_duration')), fmt_dur(m.get('estimated_time')),
                'yes' if rec.get('thumb') else 'no', j.get('filename')))
    except Exception as e:
        print('  history not available: %s' % e)
    print('Last log lines:')
    try:
        with open(LOG) as f:
            for l in f.readlines()[-5:]:
                print('  ' + l.rstrip()[:160])
    except FileNotFoundError:
        print('  (no log yet)')


def fmt_dur(s):
    if not s:
        return '-'
    s = int(s)
    return '%dh%02dm' % (s // 3600, (s % 3600) // 60)


def cmd_resend(report_id):
    jobs = [j for j in last_jobs(10) if j.get('status') in ('completed', 'cancelled')]
    if not jobs:
        print('No finished jobs in history')
        return
    j = jobs[0]
    rec = {'id': report_id, 'update': True, 'file': j.get('filename', ''),
           'status': 'done' if j.get('status') == 'completed' else 'cancelled',
           'mm': round(j.get('filament_used') or 0, 1),
           'start_ts': int(j.get('start_time') or 0) or None,
           'print_s': round(j.get('print_duration') or 0), 'total_s': round(j.get('total_duration') or 0),
           'progress': 100 if j.get('status') == 'completed' else None}
    add_metadata(rec)
    c = read_conf()
    print('Job: %s, %s, %.1f m, thumbnail: %s, slicer data: %s' % (
        rec['file'], j.get('status'), rec['mm'] / 1000.0, 'yes' if rec.get('thumb') else 'no',
        'yes' if rec.get('meta') else 'no (%s)' % rec.get('meta_error', '')))
    try:
        res = send(c.get('url', ''), c.get('token', ''), rec)
        print('Server: %s' % json.dumps(res))
    except Exception as e:
        print('ERROR: %s' % e)


def main():
    status = sys.argv[1] if len(sys.argv) > 1 else 'done'
    if status == 'check':
        cmd_check()
        return
    if status == 'resend':
        if len(sys.argv) < 3:
            print('usage: spool_report.py resend <report_id from the sheet>')
            return
        cmd_resend(sys.argv[2])
        return
    if status == 'flush':
        detach_and_flush()
        return
    try:
        mm = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
    except ValueError:
        mm = 0.0
    if mm < 1 and status != 'test':
        log('skip %s: %.1f mm' % (status, mm))
        return
    extra = []
    for a in sys.argv[3:6]:
        try:
            extra.append(float(a))
        except ValueError:
            break
    enqueue(collect(status, mm, extra))
    print('spool_tracker: %s %.0f mm queued' % (status, mm))
    sys.stdout.flush()
    detach_and_flush()


if __name__ == '__main__':
    main()
