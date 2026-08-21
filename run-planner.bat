@echo off
REM Compatibility entry point. The supported launcher owns the server, the
REM persistent Chrome profile, the canonical localhost URL and the widget.
start "" "%~dp0planner-launcher.pyw"
