Invoke-RestMethod -Uri "http://localhost:3000/meetings/start" -Method POST -Headers @{"Content-Type"="application/json"} -Body '{"meetUrl": "https://meet.google.com/hdr-nmbs-ngz"}'
run this for server.js
then change meeting url in bot.js then run it
