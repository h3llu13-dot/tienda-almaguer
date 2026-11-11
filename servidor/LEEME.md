# Tienda Almaguer en línea: servidor

Esta carpeta pone la tienda en línea en su VPS:
- La aplicación se abre desde cualquier navegador.
- Los datos se guardan en el servidor.
- Todos los equipos comparten los mismos datos: navegador, Chromebook, programa de Windows y Android.

## Instalar (Ubuntu o Debian, como root)

1. Copie esta carpeta al VPS. Por ejemplo, desde Windows (PowerShell):

   ```
   scp -r tienda-almaguer-servidor root@IP_DEL_VPS:/root/
   ```

2. Entre al VPS y ejecute el instalador:

   ```
   ssh root@IP_DEL_VPS
   cd /root/tienda-almaguer-servidor
   bash instalar.sh tienda.sudominio.com
   ```

   Si no tiene dominio, ejecute solo `bash instalar.sh` y se usará una dirección automática basada en la IP.

3. Al terminar, el instalador muestra la **dirección** y el **código de la tienda**. Guárdelos.

Si tiene dominio, primero cree un registro DNS tipo **A** que apunte el nombre (por ejemplo `tienda.sudominio.com`) a la IP del VPS. Los puertos **80** y **443** deben estar abiertos.

## Conectar los equipos

- **Navegador / Chromebook / teléfono:** abra la dirección y escriba el código de la tienda una sola vez. Después se entra con el PIN de siempre. En Chrome puede pulsar *Instalar* para tenerla como aplicación.
- **Programa de Windows y APK de Android:** vaya a Ajustes → **Tienda en línea**, escriba la dirección y el código, y pulse **Conectar**.

Los datos que ya tenga un equipo se combinan con los del servidor.

## Sin internet

Cada equipo sigue funcionando y guarda sus cambios. Al volver la conexión los envía solos. La barra superior muestra **En línea** o **Sin conexión · N pendientes**.

## Actualizar

Copie la carpeta nueva al VPS y vuelva a ejecutar `bash instalar.sh` (con el mismo dominio). Los datos y el código de la tienda no se tocan.

## Copias de seguridad

- El servidor guarda una copia diaria en `/var/lib/tienda-almaguer/backups` (últimos 30 días).
- En la aplicación, Ajustes → Tienda en línea → **Copia del servidor** descarga todo en un archivo.
