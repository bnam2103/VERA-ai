Set-Location "C:\Users\User\Documents\VERA-ai-git"

git pull

Copy-Item "C:\Users\User\Documents\VERA\Online_demo\app.js" . -Force
Copy-Item "C:\Users\User\Documents\VERA\Online_demo\index.html" . -Force
Copy-Item "C:\Users\User\Documents\VERA\Online_demo\styles.css" . -Force

Copy-Item "C:\Users\User\Documents\VERA\Online_demo\utils" . -Recurse -Force
Copy-Item "C:\Users\User\Documents\VERA\Online_demo\voice" . -Recurse -Force
Copy-Item "C:\Users\User\Documents\VERA\Online_demo\workmode" . -Recurse -Force
Copy-Item "C:\Users\User\Documents\VERA\Online_demo\news" . -Recurse -Force
Copy-Item "C:\Users\User\Documents\VERA\Online_demo\debug" . -Recurse -Force
Copy-Item "C:\Users\User\Documents\VERA\Online_demo\users" . -Recurse -Force

# Required for account checklist sync: users/checklistSupabaseSync.js must be
# listed in index.html after workmode/checklist.js (see deploy checklist in PATCH_NOTES).

git status

git add app.js index.html styles.css utils voice workmode news debug users

git commit -m "Update VERA frontend"

git push