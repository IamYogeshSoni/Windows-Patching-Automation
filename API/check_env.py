"""Shows which jumphost credentials the API will use, without printing the password.

    python check_env.py            # masked
    python check_env.py --reveal   # also prints the password (your screen only)

Compares python-dotenv's reading of .env with a literal NAME=value reading,
so a value changed by dotenv (inline '#', backslash escapes in "...", ${VAR})
shows up.
"""
import os
import sys

from dotenv import dotenv_values

here = os.path.dirname(os.path.abspath(__file__))
path = os.environ.get("SCCM_ENV_FILE") or os.path.join(here, ".env")
print(f"Env file: {path}  exists={os.path.isfile(path)}")
if not os.path.isfile(path):
    sys.exit(1)

raw = open(path, "rb").read()
if raw.startswith(b"\xef\xbb\xbf"):
    print("WARNING: the file starts with a UTF-8 BOM; the first setting name gets an invisible prefix. Save it as UTF-8 without BOM.")

dotenv = dotenv_values(path)
literal = {}
for line in raw.decode("utf-8-sig").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    name, _, value = line.partition("=")
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    literal[name.strip()] = value


def mask(v):
    if v is None:
        return "None"
    return f"<{len(v)} chars>" if len(v) < 4 else f"{v[0]}{'*' * (len(v) - 2)}{v[-1]} ({len(v)} chars)"


def show(name, secret=False):
    env_value = os.environ.get(name)
    file_value = dotenv.get(name)
    used = env_value if env_value else file_value
    source = "process environment (overrides .env)" if env_value else ".env" if file_value is not None else "NOT SET"
    shown = (used if "--reveal" in sys.argv else mask(used)) if secret else repr(used)
    print(f"{name:22} {shown}   [from {source}]")
    if used and (used != used.strip() or any(c in used for c in "\"'\r\t")):
        print(f"{'':22} WARNING: contains spaces at the ends, quotes, tabs or CR")
    if name in literal and file_value is not None and literal[name] != file_value:
        print(f"{'':22} WARNING: python-dotenv reads this differently from the literal text in the file "
              f"(literal {len(literal[name])} chars, dotenv {len(file_value)} chars). "
              "Put the value in single quotes, e.g. NAME='value'.")


show("SCCM_USERNAME")
show("SCCM_PASSWORD", secret=True)
show("SCCM_JUMPHOST")
show("SCCM_SESSION_CONFIG")
show("SCCM_TARGET_USERNAME")
show("SCCM_TARGET_PASSWORD", secret=True)
show("SCCM_DSLAB_PASSWORD", secret=True)
user = os.environ.get("SCCM_USERNAME") or dotenv.get("SCCM_USERNAME") or ""
if user and "\\" not in user and "@" not in user:
    print("WARNING: SCCM_USERNAME has no domain; use GLOBAL\\svc_patching_auto1")
