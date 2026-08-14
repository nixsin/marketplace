"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
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
  description: string;
  imageUrl?: string;
  seller: string;
  location: string;
}

export function ProductCard({ product }: { product: Product }) {
  const t = useTranslations("productCard");

  return (
    <Card className="w-full overflow-hidden py-0">
      <div className="flex flex-col sm:flex-row">
        {product.imageUrl && (
          <div className="relative h-48 w-full shrink-0 bg-muted sm:h-auto sm:w-48">
            <Image
              src={product.imageUrl}
              alt={product.name}
              fill
              sizes="(min-width: 640px) 192px, 100vw"
              className="object-cover"
            />
          </div>
        )}

        <div className="flex flex-1 flex-col">
          <CardHeader className="pt-4">
            <div className="flex items-center justify-between">
              <Badge variant="secondary">{product.category}</Badge>
              {product.deviceClass && (
                <Badge variant="outline">
                  {t("deviceClass", { class: product.deviceClass })}
                </Badge>
              )}
            </div>
            <CardTitle className="text-lg">{product.name}</CardTitle>
            <CardDescription>
              {t("meta", {
                brand: product.brand,
                seller: product.seller,
                location: product.location,
              })}
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-1 flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {product.description}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {product.certifications.map((cert) => (
                <Badge key={cert} variant="outline" className="gap-1">
                  <ShieldCheck className="size-3" />
                  {cert}
                </Badge>
              ))}
            </div>
          </CardContent>

          <CardFooter className="flex items-center justify-between py-4">
            <span className="text-sm text-muted-foreground">
              {t("priceOnRequest")}
            </span>
            <Button size="sm">{t("sendInquiry")}</Button>
          </CardFooter>
        </div>
      </div>
    </Card>
  );
}
