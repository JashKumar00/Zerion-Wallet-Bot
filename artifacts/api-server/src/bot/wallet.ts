import { ethers } from "ethers";
import CryptoJS from "crypto-js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { CHAINS } from "./chains.js";

const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY!;

// ─── EVM ─────────────────────────────────────────────────────────────────────

export function generateWallet(): { address: string; privateKey: string } {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export function encryptPrivateKey(privateKey: string): string {
  return CryptoJS.AES.encrypt(privateKey, MASTER_KEY).toString();
}

export function decryptPrivateKey(encryptedKey: string): string {
  const bytes = CryptoJS.AES.decrypt(encryptedKey, MASTER_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export function getWallet(encryptedPrivateKey: string, chainId = "base"): ethers.Wallet {
  const privateKey = decryptPrivateKey(encryptedPrivateKey);
  const rpc = CHAINS[chainId]?.rpc ?? CHAINS.base.rpc;
  const provider = new ethers.JsonRpcProvider(rpc);
  return new ethers.Wallet(privateKey, provider);
}

// ─── Solana ───────────────────────────────────────────────────────────────────

export function generateSolanaWallet(): { pubkey: string; secretKeyBase58: string } {
  const kp = Keypair.generate();
  return {
    pubkey: kp.publicKey.toBase58(),
    secretKeyBase58: bs58.encode(kp.secretKey),
  };
}

export function encryptSolanaKey(secretKeyBase58: string): string {
  return CryptoJS.AES.encrypt(secretKeyBase58, MASTER_KEY).toString();
}

export function decryptSolanaKey(encryptedKey: string): string {
  const bytes = CryptoJS.AES.decrypt(encryptedKey, MASTER_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export function getSolanaKeypair(encryptedKey: string): Keypair {
  const secretKeyBase58 = decryptSolanaKey(encryptedKey);
  return Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
}
