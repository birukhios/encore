"""Start Encore locally and open the real web application, not a file preview."""
import os,sys,threading,webbrowser,hashlib,glob,subprocess
CHECK='import sys,hashlib;sys.exit(not(sys.version_info>=(3,11) and hasattr(hashlib,"scrypt")))'
def suitable_python():
 found=[os.environ.get('ENCORE_PYTHON','')]
 for pattern in ['/Library/Frameworks/Python.framework/Versions/3.1[1-9]/bin/python3','/opt/homebrew/opt/python@3.1[1-9]/bin/python3.1[1-9]','/usr/local/opt/python@3.1[1-9]/bin/python3.1[1-9]','/opt/homebrew/bin/python3.1[1-9]','/usr/local/bin/python3.1[1-9]','/usr/bin/python3.1[1-9]','/opt/homebrew/bin/python3','/usr/local/bin/python3',os.path.expanduser('~/.local/share/uv/python/cpython-3.1[1-9]*/bin/python3.1[1-9]')]:
  found+=sorted(glob.glob(pattern),reverse=True)
 for candidate in found:
  if candidate and os.access(candidate,os.X_OK) and os.path.realpath(candidate)!=os.path.realpath(sys.executable):
   try:
    if subprocess.run([candidate,'-c',CHECK],timeout=15).returncode==0:return candidate
   except Exception:pass
if sys.version_info < (3,11) or not hasattr(hashlib,"scrypt"):
 better=None if os.environ.get('ENCORE_REEXEC') else suitable_python()
 if better:
  os.environ['ENCORE_REEXEC']='1';os.execv(better,[better,os.path.abspath(__file__)]+sys.argv[1:])
 print("Encore requires Python 3.11+ with scrypt support. This interpreter is: "+sys.executable+" ("+sys.version.split()[0]+")")
 print("macOS's built-in python3 cannot be used. Install Python 3.12 from https://www.python.org/downloads/ or run: brew install python@3.12")
 print("Then start Encore again. No other setup is needed.")
 sys.exit(1)
from pathlib import Path
if '--test' in sys.argv:
 import unittest
 os.chdir(Path(__file__).parent)
 suite=unittest.defaultTestLoader.discover('tests')
 sys.exit(0 if unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful() else 1)
os.environ.setdefault('PORT','8081')
os.environ.setdefault('GUEST_PORT','8082')
import server

def main():
 dist=Path(__file__).parent/'dist'
 if not (dist/'admin.html').is_file() or not (dist/'guest.html').is_file():
  print('The application files are missing. Extract the complete Encore ZIP first, or run: npm run build');return 1
 problems=server.production_problems()
 for problem in problems:print(('WARNING: ' if 'SMS_PROVIDER' in problem else 'ERROR: ')+problem,flush=True)
 if any('SMS_PROVIDER' not in p for p in problems):
  print('Encore will not start in production until these are fixed. See .env.example.');return 1
 server.init()
 host=os.environ.get('HOST','127.0.0.1')
 if server.SINGLE_PORT:
  try:http=server.serve(server.CombinedHandler,host,server.ADMIN_PORT)
  except OSError as exc:
   print('Encore could not start: '+str(exc));return 1
  print('Encore guest app:       '+server.GUEST_ORIGIN+'/',flush=True)
  print('Encore organizer admin: '+server.ADMIN_ORIGIN+'/admin',flush=True)
  try:http.serve_forever()
  except KeyboardInterrupt:print('\nEncore stopped.')
  finally:http.server_close()
  return 0
 try:
  admin=server.serve(server.AdminHandler,host,server.ADMIN_PORT)
  guest=server.serve(server.GuestHandler,host,server.GUEST_PORT)
 except OSError as exc:
  print('Encore could not start: '+str(exc))
  print('If another copy is running, close it, or choose other ports: PORT=8091 GUEST_PORT=8092 python3 launch.py')
  return 1
 threading.Thread(target=guest.serve_forever,daemon=True).start()
 print('Encore organizer admin: '+server.ADMIN_ORIGIN+'/admin',flush=True)
 print('Encore guest app:       '+server.GUEST_ORIGIN+'/',flush=True)
 print('Keep this window open while using Encore. Press Control-C to stop.',flush=True)
 if '--no-browser' not in sys.argv:threading.Timer(0.5,lambda:webbrowser.open(server.ADMIN_ORIGIN+'/admin')).start()
 try:admin.serve_forever()
 except KeyboardInterrupt:print('\nEncore stopped.')
 finally:
  admin.server_close();guest.shutdown();guest.server_close()
 return 0
if __name__=='__main__':sys.exit(main())
