import { describe, it, expect, afterAll } from "vitest";
import {
  createProductionEvent, listProductionEvents, getProductionEvent,
  updateProductionEvent, deleteProductionEvent,
  createScheduleItem, listScheduleItems, updateScheduleItem, deleteScheduleItem,
} from "@/lib/event-db";
import { PROD_HOSHINO, TEST_USER } from "./helpers";

const EVENT_ID = "test-event-unit";
const ITEM_ID  = "test-item-unit";

afterAll(() => deleteProductionEvent(EVENT_ID, PROD_HOSHINO).catch(() => {}));

describe("event CRUD", () => {
  it("createProductionEvent creates an event", async () => {
    await createProductionEvent({
      id: EVENT_ID, productionId: PROD_HOSHINO,
      title: "单元测试排练", eventType: "rehearsal",
      location: "排练室A", startTime: "2026-08-01T10:00:00Z",
      endTime: "2026-08-01T13:00:00Z", description: "",
      createdBy: TEST_USER,
    });
    const event = await getProductionEvent(EVENT_ID, PROD_HOSHINO);
    expect(event).not.toBeNull();
    expect(event!.title).toBe("单元测试排练");
    expect(event!.location).toBe("排练室A");
  });

  it("listProductionEvents includes the created event", async () => {
    const events = await listProductionEvents(PROD_HOSHINO);
    expect(events.some((e) => e.id === EVENT_ID)).toBe(true);
  });

  it("updateProductionEvent changes the title", async () => {
    await updateProductionEvent(EVENT_ID, PROD_HOSHINO, { title: "单元测试排练（改名）" });
    const event = await getProductionEvent(EVENT_ID, PROD_HOSHINO);
    expect(event!.title).toBe("单元测试排练（改名）");
  });

  it("getProductionEvent returns null for wrong production", async () => {
    expect(await getProductionEvent(EVENT_ID, "wrong-prod")).toBeNull();
  });
});

describe("schedule item CRUD", () => {
  it("createScheduleItem adds an item", async () => {
    await createScheduleItem({
      id: ITEM_ID, eventId: EVENT_ID,
      title: "热身活动", itemType: "custom",
      startTime: null, endTime: null, location: "",
      orderIndex: 0, targetSceneId: null, targetBlockId: null, notes: "",
    });
    const items = await listScheduleItems(EVENT_ID);
    expect(items.some((i) => i.id === ITEM_ID)).toBe(true);
  });

  it("updateScheduleItem changes the title", async () => {
    await updateScheduleItem(ITEM_ID, EVENT_ID, { title: "热身活动（已修改）" });
    const items = await listScheduleItems(EVENT_ID);
    expect(items.find((i) => i.id === ITEM_ID)!.title).toBe("热身活动（已修改）");
  });

  it("deleteScheduleItem removes the item", async () => {
    await deleteScheduleItem(ITEM_ID, EVENT_ID);
    const items = await listScheduleItems(EVENT_ID);
    expect(items.some((i) => i.id === ITEM_ID)).toBe(false);
  });

  it("deleteProductionEvent cascades", async () => {
    await deleteProductionEvent(EVENT_ID, PROD_HOSHINO);
    expect(await getProductionEvent(EVENT_ID, PROD_HOSHINO)).toBeNull();
  });
});
