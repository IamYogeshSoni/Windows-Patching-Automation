# SCCM Windows Server Patching Automation

| Folder | Contents | Where it runs |
|---|---|---|
| `Automation\` | PowerShell patching package: `Run-Patching.ps1`, `Scripts\`, `Modules\`, `Config\`, `Reports\` | Jumphost — copy the whole folder there (e.g. `C:\SCCM_Automation`) |
| `API\` | FastAPI service (`app.py`), Postman collection, API testing guide | Cloud PC |
| `Client\` | PowerShell operator client for the API | Cloud PC |
| `Frontend\` | Frontend integration guide and TypeScript client | Frontend project |
| `Docs\` | Patching SOP and server-list SOP (PDF) | — |

- Manual run on the jumphost: see `Automation\README.md` and `.\Automation\Run-Patching.ps1 -?`.
- The API runs the scripts from the jumphost copy of `Automation\`; start it with `$env:SCCM_PROJECT_ROOT` set to that folder (e.g. `C:\SCCM_Automation`). See `API\README.md`.
