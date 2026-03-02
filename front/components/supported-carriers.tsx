"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plane } from "lucide-react";

interface CarrierInfo {
  name: string;
  prefixes: string[];
}

const CARRIERS: CarrierInfo[] = [
  { name: "DHL Aviation", prefixes: ["155", "423", "615", "936", "947", "992"] },
  { name: "Atlas Air", prefixes: ["369", "403"] },
  { name: "China Cargo", prefixes: ["112", "781"] },
  { name: "MAS Air", prefixes: ["865", "870"] },
  { name: "Turkish Cargo", prefixes: ["235"] },
  { name: "Amerijet", prefixes: ["810"] },
  { name: "AF/KLM Cargo", prefixes: ["057", "074", "129"] },
  { name: "IAG Cargo", prefixes: ["053", "060", "075", "125"] },
];

export function SupportedCarriers() {
  const totalPrefixes = CARRIERS.flatMap((c) => c.prefixes).length;

  return (
    <Card className="w-full max-w-xl">
      <CardHeader className="p-3 pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Plane className="h-4 w-4" />
            Aerolíneas
          </CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {CARRIERS.length} carriers / {totalPrefixes} prefijos
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {CARRIERS.map((carrier) => (
            <div
              key={carrier.name}
              className="flex items-center justify-between p-2 rounded border bg-card"
            >
              <span className="text-xs font-medium truncate mr-2">{carrier.name}</span>
              <div className="flex gap-0.5 shrink-0">
                {carrier.prefixes.map((prefix) => (
                  <Badge key={prefix} variant="outline" className="font-mono text-[10px] px-1 py-0">
                    {prefix}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
