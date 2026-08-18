# Bot de WhatsApp con respuestas automáticas

Este proyecto crea un chatbot para WhatsApp usando la librería Baileys, una opción estable y muy mantenida para automatizar conversaciones.

## Requisitos

- Node.js 18 o superior
- Una cuenta de WhatsApp activa en tu teléfono

## Instalación

1. Abre la terminal en la carpeta del proyecto.
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Ajusta las variables de entorno en el archivo .env si lo necesitas.

## Ejecución

1. Inicia el bot:
   ```bash
   npm start
   ```
2. Se mostrará un código QR en la terminal.
3. Ábrelo con WhatsApp en tu teléfono y escanéalo desde la opción de vincular dispositivo.
4. Una vez conectado, el bot responderá automáticamente a los mensajes entrantes.

## Personalizar respuestas

Las respuestas automáticas se definen en:
- src/services/responseService.js

Puedes agregar nuevas reglas editando el arreglo responseRules.

## Estructura del proyecto

- src/index.js: punto de entrada
- src/config/env.js: carga de variables de entorno
- src/services/whatsappService.js: conexión y manejo de mensajes
- src/services/conversationService.js: manejo de flujo conversacional con opciones y respuestas encadenadas
- src/services/responseService.js: lógica para respuestas por palabra clave
- src/utils/messageUtils.js: extracción de texto desde mensajes

## Flujo de conversación

- Si el usuario saluda, el bot ofrece un menú de opciones.
- El usuario elige una opción y el bot hace una pregunta de seguimiento.
- Al terminar la consulta, el bot envía un mensaje de agradecimiento.
- Si el usuario pide catálogo, el bot envía un PDF desde `assets/catalogo.pdf`.

## Notas

- La sesión de autenticación se guarda en la carpeta `.wwebjs_auth`.
- Si el bot se desconecta, reinícialo y escanea el QR otra vez.
# bot-consentido
