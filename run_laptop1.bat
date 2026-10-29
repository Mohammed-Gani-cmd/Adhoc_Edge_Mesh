@echo off
cd /d %~dp0
call .venv\Scripts\activate
python -m edge_mesh --name Laptop-1 --port 5000 --token demo123
