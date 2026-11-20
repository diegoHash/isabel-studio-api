-- Una cita puede incluir varios servicios (carrito). service_id/service_name se conservan
-- (primer servicio / nombres unidos) para compatibilidad y búsquedas.
ALTER TABLE appointments ADD COLUMN services_json TEXT;
ALTER TABLE appointments ADD COLUMN total INTEGER NOT NULL DEFAULT 0;
