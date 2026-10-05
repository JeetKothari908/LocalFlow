import { Config } from "../../types";
import TodoPlus from "./TodoPlus";
import TodoSettings from "../todo/TodoSettings";

const config: Config = {
  key: "widget/todo",
  name: "Tasks",
  description: "Projects, nested tasks, dependencies, and daily planning.",
  dashboardComponent: TodoPlus,
  settingsComponent: TodoSettings,
};

export default config;
