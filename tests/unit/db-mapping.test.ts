import {
  mapCreateAuthorToInsert,
  mapCreateTodoToInsert,
  mapUpdateAuthorToValues,
  mapUpdateTodoToValues,
} from "@pgxsinkit/schema";

describe("db mapping helpers", () => {
  it("maps author payloads into insert and update shapes", () => {
    const created = mapCreateAuthorToInsert({
      id: "01963227-d4c7-72db-b858-f89f6af8f920",
      name: "Ada Lovelace",
    });

    expect(created).toEqual({
      id: "01963227-d4c7-72db-b858-f89f6af8f920",
      name: "Ada Lovelace",
    });

    expect(mapUpdateAuthorToValues({ name: "Grace Hopper" })).toEqual({ name: "Grace Hopper" });
  });

  it("normalizes nullable create fields", () => {
    const values = mapCreateTodoToInsert({
      id: "01963227-d4c7-72db-b858-f89f6af8f999",
      title: "Seed row",
      description: undefined,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "medium",
    });

    expect(values.id).toBe("01963227-d4c7-72db-b858-f89f6af8f999");
    expect(values.authorId).toBe("01963227-d4c7-72db-b858-f89f6af8f920");
    expect(values.description).toBeNull();
  });

  it("returns only explicitly updated keys", () => {
    const values = mapUpdateTodoToValues({
      title: "Retitled",
      authorId: "01963227-d4c7-72db-b858-f89f6af8f921",
    });

    expect(values).toEqual({
      authorId: "01963227-d4c7-72db-b858-f89f6af8f921",
      title: "Retitled",
    });
  });
});
