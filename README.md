# Datos Abiertos

Extrae tablas HTML, CSV y JSON de fuentes públicas, selecciona columnas, filtra y ordena filas y exporta a Excel o CSV.

## Compilar

Ejecuta `npm run build` con Node.js. El archivo compilado queda en `dist/server/index.js`.

## Desplegar

En Cloudflare Workers, importa este repositorio desde GitHub. Usa `npm run build` como comando de compilación y `npx wrangler deploy` como comando de despliegue.

## Probar en local

Ejecuta `npm run build` y después `npx wrangler dev`.
