document.addEventListener("DOMContentLoaded", function() {
    // Select the About and Experience sections
    const aboutSection = document.getElementById("about");
    const experienceSection = document.getElementById("experience");
    const projectSection = document.getElementById("projects");

    // Add fade-in class to About Me section on page load
    aboutSection.classList.add("fade-in-about");

    // Once About Me is fully visible, trigger Experience fade-in with delay
    aboutSection.addEventListener("transitionend", () => {
        experienceSection.classList.add("fade-in-experience");
    });

    experienceSection.addEventListener("transitionend", () => {
        projectSection.classList.add("fade-in-project");
    });
});