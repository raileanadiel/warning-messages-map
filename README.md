## Warning Messages Map – Deployment Guide

### Build and push Docker image

```bash
cd /home/adiel/Desktop/warning-messages-app
docker build -t raileana/warning-messages-app:latest .
docker push raileana/warning-messages-app:latest
```

### Deploy / update on production server

On the production server (where your `docker-compose.yml` for this app lives):

```bash
cd /opt/warning-map/
sudo docker compose -f docker-compose.yml pull
sudo docker compose -f docker-compose.yml up -d
```