# Ajustes propuestos para Abby - Con Sentido

Este paquete fue preparado a partir del estado publico del repositorio `alejandroR0710/bot-consentido` revisado el 18 de agosto de 2026 y de los flujos comerciales definidos con Alejandra.

## Archivos

- `src/config/knowledgeBase.js`: precios, horarios, tecnicas, medios de pago y datos que cambian con frecuencia.
- `src/services/conversationService.js`: reemplazo propuesto de la maquina de estados conversacional para los flujos ya definidos.
- `src/services/whatsappService.js`: ajuste importante para aceptar comprobantes enviados como imagen/PDF sin caption y para enviar el resumen al asesor.
- `test/conversationService.updated.test.js`: pruebas basicas de regresion de los flujos nuevos.

## Alcance cerrado

1. Talleres
   - MasterClass Basico grupal: $250.000, domingos programados, 9 a.m. a 3 p.m., maximo 10 personas.
   - MasterClass Basico Personalizado: $300.000, lunes a viernes, 9-1 o 3-7.
   - MasterClass Avanzado: $300.000, lunes a viernes, 9-1 o 3-7. Tecnicas: masaje, cera gel y Chantilly.
   - Reserva de $80.000 donde aplica y comprobante antes de confirmacion humana.

2. Experiencia Con Sentido
   - $120.000 por persona, minimo 2, aprox. 3 horas.
   - Bebida, Momento Con Sentido, breve introduccion a ceras, una vela por persona, Migao, fotos y video.
   - Cumpleaños: decoracion +$20.000 y torta +$10.000 por persona.

3. Insumos
   - Catalogo fragancias / catalogo general / pedido directo / asesoria.
   - Con Sentido no pide domicilios por app; el cliente solicita su mensajero y envia nombre, placa y codigo.
   - Envio nacional: +$2.000 de embalaje. Flete depende de destino/transportadora.
   - Pago: Nequi o Llave.

4. Velas y regalos
   - Menu reorganizado.
   - Subflujo de bouquets implementado hasta seleccion, tarjeta y finalizacion del pedido.
   - Las demas categorias se dejan derivadas al equipo porque aun no se ha cerrado su conversacion comercial con Alejandra.

## Cambios importantes respecto al repo actual

- Se elimina la pregunta de presupuesto en talleres y experiencias.
- Se elimina la pregunta de ciudad como requisito para presentar un taller.
- El Avanzado ya no muestra un precio grupal de $250.000: el valor definido es $300.000.
- Se reemplaza "Experiencias creativas" por "Experiencia Con Sentido" como producto unico personalizable.
- El bot pregunta solo cuando la respuesta cambia la recomendacion o permite avanzar.
- Se crea un cierre de pago consistente: nombre completo de reserva/pedido -> Nequi/Llave -> comprobante -> validacion humana.
- Un comprobante en imagen o PDF sin texto ya no se pierde.
- `advisorSummary` ahora se envia realmente al chat configurado para asesor.

## Variables de entorno recomendadas

Agregar a `.env`:

```env
NEQUI_NUMBER=3153047547
PAYMENT_KEY=0090622675
ADVISOR_WHATSAPP_NUMBER=57XXXXXXXXXX
```

`ADVISOR_WHATSAPP_NUMBER` debe ir con indicativo de pais y solo digitos.

## Punto que falta para automatizar 100% los pedidos de insumos

El PDF del catalogo sirve para mostrar productos, pero para que Abby calcule subtotales automaticamente necesita una fuente estructurada de precios (JSON, CSV o base de datos). El flujo incluido captura el pedido en texto y conserva la logica de entrega/pago sin inventar precios.

Sugerencia siguiente: crear `data/products.json` o una tabla administrable con `sku`, `nombre`, `categoria`, `presentacion`, `precio`, `activo` y `stock`.
