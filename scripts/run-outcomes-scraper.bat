@echo off
REM TheRxOS Outcomes Email Scraper - Scheduled Task
REM Runs nightly at 2am EST to fetch Outcomes dispensing reports

cd /d C:\Users\Stan\Desktop\therxos-backend

REM Log start time
echo ============================================ >> logs\scraper.log
echo %date% %time% - Starting Outcomes scraper >> logs\scraper.log

REM Run the scraper
node scripts\scrape-outcomes.js >> logs\scraper.log 2>&1

REM Log completion
echo %date% %time% - Scraper completed >> logs\scraper.log
echo ============================================ >> logs\scraper.log
