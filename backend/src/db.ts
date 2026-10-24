import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

export const prisma = new PrismaClient();