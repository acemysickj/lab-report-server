@echo off
chcp 65001 >nul
title 实验报告助手 · 发额度
cd /d "D:\Claude Program\开发\lab-report-server"
echo 正在启动管理页（自动打开浏览器）...
node scripts\admin-gui.mjs http://120.79.10.96
pause
