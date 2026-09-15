"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { hasSignedIn } from "@/lib/api";

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    router.replace(hasSignedIn() ? "/home" : "/login");
  }, [router]);

  return null;
}
