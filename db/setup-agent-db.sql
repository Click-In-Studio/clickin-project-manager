-- Run as postgres superuser: sudo -u postgres psql
-- Replace CHANGE_ME with a strong password before running.

CREATE DATABASE click_in_agent;
CREATE USER agent_user WITH PASSWORD 'CHANGE_ME';
GRANT ALL PRIVILEGES ON DATABASE click_in_agent TO agent_user;
