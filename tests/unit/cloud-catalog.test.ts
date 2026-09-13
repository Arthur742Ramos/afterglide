import { describe, expect, it } from "vitest";
import {
  buildSessionPayload,
  mapCloudTitles,
} from "../../src/main/live-platform-service";

describe("cloud catalog mapping", () => {
  it("routes cloud title IDs and home console IDs to distinct session fields", () => {
    expect(
      buildSessionPayload({ source: "cloud", id: "cloud-title" }, 1080),
    ).toMatchObject({ titleId: "cloud-title", serverId: "" });
    expect(
      buildSessionPayload({ source: "home", id: "console-id" }, 720),
    ).toMatchObject({
      titleId: "",
      serverId: "console-id",
      settings: { osName: "android" },
    });
  });

  it("joins stream titles to catalog metadata and puts recent games first", () => {
    const titles = mapCloudTitles(
      [
        {
          titleId: "second",
          details: { productId: "p2", supportedInputTypes: ["Controller"] },
        },
        {
          titleId: "first",
          details: { productId: "p1", supportedInputTypes: ["Controller"] },
        },
      ],
      [
        {
          StoreId: "p1",
          ProductTitle: "Alpha",
          PublisherName: "Publisher A",
          Image_Tile: { URL: "//store-images.s-microsoft.com/image.png" },
        },
        {
          StoreId: "p2",
          ProductTitle: "Beta",
          PublisherName: "Publisher B",
          Image_Tile: { URL: "https://untrusted.example/art.png" },
        },
      ],
      new Set(["second"]),
    );

    expect(titles.map((title) => title.id)).toEqual(["second", "first"]);
    expect(titles[0]).toMatchObject({
      name: "Beta",
      recentlyPlayed: true,
      imageUrl: undefined,
    });
    expect(titles[1]?.imageUrl).toBe(
      "https://store-images.s-microsoft.com/image.png",
    );
  });
});
