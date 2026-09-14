"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { getToken } from "@/lib/api";

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getToken() ? "/home" : "/login");
  }, [router]);

  return null;
}
