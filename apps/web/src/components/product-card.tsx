import { ShieldCheck, Stethoscope } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: string;
  deviceClass?: "A" | "B" | "C" | "D";
  certifications: string[];
  seller: string;
  location: string;
}

export function ProductCard({ product }: { product: Product }) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <Badge variant="secondary">{product.category}</Badge>
          {product.deviceClass && (
            <Badge variant="outline">Class {product.deviceClass}</Badge>
          )}
        </div>
        <CardTitle className="text-lg">{product.name}</CardTitle>
        <CardDescription>
          {product.brand} · Sold by {product.seller} · {product.location}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Stethoscope className="size-4" />
          <span className="text-sm">{product.category}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {product.certifications.map((cert) => (
            <Badge key={cert} variant="outline" className="gap-1">
              <ShieldCheck className="size-3" />
              {cert}
            </Badge>
          ))}
        </div>
      </CardContent>

      <CardFooter className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Price on request
        </span>
        <Button size="sm">Send Inquiry</Button>
      </CardFooter>
    </Card>
  );
}
