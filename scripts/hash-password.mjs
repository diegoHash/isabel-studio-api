#!/usr/bin/env node
// Uso: npm run hash-password -- "tu-clave-larga"
// Imprime el hash PBKDF2 para guardarlo como secreto: wrangler secret put ADMIN_PASSWORD_HASH
import { webcrypto as crypto } from "node:crypto";

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('Uso: npm run hash-password -- "clave-de-al-menos-12-caracteres"');
  process.exit(1);
}
const ITERATIONS = 100_000; // máximo que permite Cloudflare Workers
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
console.log(`pbkdf2$${ITERATIONS}$${hex(salt)}$${hex(bits)}`);
