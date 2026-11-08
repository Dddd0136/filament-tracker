#!/usr/bin/env python3
# Filament tracker: reports a finished/cancelled print to the Google Apps Script web app.
# Called from Klipper:
#   RUN_SHELL_COMMAND CMD=spool_report PARAMS="done <filament_mm> <print_s> <total_s> <progress 0..1>"
#   argv[1] = done | cancelled | test | flush
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
    if not rec['file']:
        return rec
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
    return rec


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


def main():
    status = sys.argv[1] if len(sys.argv) > 1 else 'done'
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
