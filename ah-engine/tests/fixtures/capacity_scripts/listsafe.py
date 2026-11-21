import subprocess
subprocess.run(['git', 'status'])
subprocess.run(['git', '-C', '.', 'log'])
