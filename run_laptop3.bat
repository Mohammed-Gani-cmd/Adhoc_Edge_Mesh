@echo off
setlocal
if "%~1"=="" (
  echo Usage: run_laptop3.bat COORDINATOR_IP
  exit /b 1
)
.venv\Scripts\python.exe -m edge_mesh --name Laptop-3 --port 5002 --token demo123 --peer %~1:5000
