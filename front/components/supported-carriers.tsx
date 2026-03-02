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
    <Card className="w-full max-w-md shadow-sm border-border/60">
      <CardHeader className="p-4 pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Plane className="h-4 w-4" />
            Aerolíneas
          </CardTitle>
          <Badge variant="secondary" className="text-[10px] shadow-sm">
            {CARRIERS.length} carriers / {totalPrefixes} prefijos
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="space-y-2">
          {CARRIERS.map((carrier) => (
            <div
              key={carrier.name}
              className="flex items-center justify-between p-2.5 rounded-lg border border-border/40 bg-muted/30"
            >
              <span className="text-xs font-medium">{carrier.name}</span>
              <div className="flex gap-1 flex-wrap justify-end">
                {carrier.prefixes.map((prefix) => (
                  <Badge key={prefix} variant="outline" className="font-mono text-[10px] px-1.5 py-0 bg-background">
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
