export interface Service {
  id: string;
  category: string;
  name: string;
  /** Precio en COP; null cuando depende del caso. */
  price: number | null;
  priceNote?: string;
}

/** Catálogo oficial. El PWA mantiene una copia de solo lectura para mostrar la lista de precios. */
export const SERVICES: readonly Service[] = [
  { id: "manicure-semipermanente", category: "Manicure y pedicure", name: "Manicure semipermanente", price: 48000 },
  { id: "pedicure-semipermanente", category: "Manicure y pedicure", name: "Pedicure semipermanente", price: 40000 },
  { id: "manicure-semipermanente-caballero", category: "Manicure y pedicure", name: "Manicure semipermanente caballero", price: 30000 },
  { id: "pedicure-semipermanente-caballero", category: "Manicure y pedicure", name: "Pedicure semipermanente caballero", price: 30000 },
  { id: "sistema-acrilico", category: "Manicure y pedicure", name: "Sistema acrílico", price: 100000 },
  { id: "sistema-soft-gel", category: "Manicure y pedicure", name: "Sistema soft gel", price: 85000 },
  { id: "sistema-poligel", category: "Manicure y pedicure", name: "Sistema poligel", price: 90000 },
  { id: "caping-poligel-acrilico", category: "Manicure y pedicure", name: "Caping uña natural (poligel - acrílico)", price: 70000 },
  { id: "caping-builder-gel", category: "Manicure y pedicure", name: "Caping uña natural (builder gel)", price: 60000 },
  { id: "diping-una-natural", category: "Manicure y pedicure", name: "Diping uña natural", price: 60000 },
  { id: "depilacion-cejas", category: "Cejas", name: "Depilación de cejas", price: 10000 },
  { id: "micropigmentacion-cejas", category: "Cejas", name: "Micropigmentación de cejas", price: 160000 },
  { id: "keratina", category: "Cabello", name: "Aplicación de keratina", price: null, priceNote: "Según el largo del cabello" },
  { id: "trenzas", category: "Cabello", name: "Trenzas", price: null, priceNote: "Según el modelo" },
];

export function findService(id: string): Service | undefined {
  return SERVICES.find((s) => s.id === id);
}
