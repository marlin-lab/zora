@echo off
setlocal
powershell -NoProfile -WindowStyle Hidden -Command "$c=New-Object Net.Sockets.TcpClient;try{$c.Connect('127.0.0.1',8686);$c.Close();exit 0}catch{exit 1}"
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'D:\node.exe' -ArgumentList 'C:\Users\yxm\zhishik\server.js' -WorkingDirectory 'C:\Users\yxm\zhishik' -WindowStyle Hidden"
  timeout /t 2 /nobreak >nul
)
start "" "http://localhost:8686/"
exit
