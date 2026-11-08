#!/usr/bin/env python3
# Filament tracker: reports filament used by a print to the Google Apps Script web app.
# Called from Klipper:  RUN_SHELL_COMMAND CMD=spool_report PARAMS="done 1234.5"
#   argv[1] = done | cancelled | test | flush
#   argv[2] = filament used, mm
# Reports are queued in ~/spool_queue.jsonl and re-sent later if the internet is down.
# Python 3.7 compatible, standard library only. Output is ASCII only (old Klipper).
import sys, os, json, time, fcntl, urllib.request, urllib.parse

HOME = os.path.expanduser('~')
CONF = os.path.join(HOME, 'klipper_config', 'spool_tracker.conf')
QUEUE = os.path.join(HOME, 'spool_queue.jsonl')
LOCK = QUEUE + '.lock'
LOG = os.path.join(HOME, 'klipper_logs', 'spool_tracker.log')
MOONRAKER = 'http://127.0.0.1:7125'


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


def current_filename():
    try:
        url = MOONRAKER + '/printer/objects/query?print_stats=filename'
        with urllib.request.urlopen(url, timeout=3) as r:
            d = json.loads(r.read().decode('utf-8'))
        return d['result']['status']['print_stats'].get('filename', '') or ''
    except Exception as e:
        log('moonraker query failed: %s' % e)
        return ''


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
    qs = urllib.parse.urlencode({'token': token, 'data': json.dumps(rec, ensure_ascii=False)})
    with urllib.request.urlopen(url + ('&' if '?' in url else '?') + qs, timeout=25) as r:
        body = json.loads(r.read().decode('utf-8'))
    if not body.get('ok'):
        raise RuntimeError('server: %s' % body.get('error'))
    return body


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
                log('dropped bad line: %r' % line[:80])
                continue
            try:
                body = send(url, token, rec)
                log('sent %s %s mm -> %s' % (rec.get('status'), rec.get('mm'), json.dumps(body, ensure_ascii=True)))
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
    rec = {
        'id': '%d-%d' % (int(time.time() * 1000), os.getpid()),
        'ts': int(time.time()),
        'file': current_filename(),
        'status': status,
        'mm': round(mm, 1),
    }
    enqueue(rec)
    print('spool_tracker: %s %.0f mm queued' % (status, mm))
    sys.stdout.flush()
    detach_and_flush()


if __name__ == '__main__':
    main()
