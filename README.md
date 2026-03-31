# Fitted image proxy for Railway

This service takes up to 12 candidate image URLs (`photo1..photo6` and `photo1b..photo6b`), downloads them on the server, caches the first 3 working images, and returns fresh Railway-hosted URLs that Telegram can fetch reliably.

## Endpoints

- `GET /health`
- `GET or POST /select-images`
- `GET /image/:id.ext`

## Example

`/select-images?photo1=https://...&photo1b=https://...`

Response:

```json
{
  "ok": true,
  "image1": "https://your-service.up.railway.app/image/abc.jpg",
  "image2": "https://your-service.up.railway.app/image/def.jpg",
  "image3": "https://your-service.up.railway.app/image/ghi.jpg"
}
```
